#!/usr/bin/env bash
# Autonomous full-stack E2E with a REAL agent CLI on the agent side.
#
#   codex (real agent) ──MCP──► agent serve ──seal──► relay (kind) ──► real PWA (headless)
#                          ◄──────────── sealed decision ◄────────────────┘
#
# A real `codex exec` agent calls the request_approval MCP tool; the tool blocks while a
# headless Chromium running the REAL PWA pairs over SPAKE2 and answers; the sealed decision
# flows back through the kind relay to the agent. Nothing is mocked.
#
# Requires `make ci-up` first (relay :8080 + web :8081 live in kind).
# env: KIND=yesno|choice|text (default yesno)
#      AGENT_CLI=cursor|direct|codex (default cursor)
#        cursor — real LLM agent via cursor-agent (--approve-mcps; reads .cursor/mcp.json)
#        direct — deterministic MCP client, no LLM/API key (CI-friendly control)
#        codex  — works only interactively; headless `codex exec` cancels MCP tool calls
#                 (per-call permission prompt has no responder). Kept for reference.
set -euo pipefail
umask 077  # pair-log carries the SPAKE2 secret (room id + code) — owner-only.
cd "$(dirname "$0")/.."

KIND="${KIND:-yesno}"
AGENT_CLI="${AGENT_CLI:-cursor}"
LAUNCH="$PWD/scripts/mcp-serve-test.sh"
# Keep the pair-log inside the repo: under codex's workspace-write sandbox the MCP server
# can write here (a system-temp path may be outside the sandbox's writable roots).
LOG="$PWD/.aah-pair.log"
PHONE_OUT="${TMPDIR:-/tmp}/aah-phone.out"
AGENT_OUT="${TMPDIR:-/tmp}/aah-agent.out"
chmod +x "$LAUNCH"
install -m600 /dev/null "$LOG"  # 0600 + no symlink-follow (carries the pairing secret).

# Pre-flight: the kind system must be up.
curl -fsS -m4 http://localhost:8080/healthz >/dev/null || { echo "relay down at :8080 — run 'make ci-up'" >&2; exit 1; }
curl -fsS -m4 -o /dev/null http://localhost:8081/ || { echo "web down at :8081 — run 'make ci-up'" >&2; exit 1; }
# Always rebuild from source — a stale/committed ./bin/agent must never bypass source fixes.
( cd backend && go build -o ../bin/agent ./cmd/agent )

case "$KIND" in
  yesno)  ASK="Set title='Production deploy', category='deploy', summary='Deploy v2.3.1 to prod?', response_kind='yesno'." ;;
  choice) ASK="Set title='Pick a lane', category='deploy', summary='Proceed or hold?', response_kind='choice', options=['Proceed','Hold']." ;;
  text)   ASK="Set title='Name the release', category='other', summary='What should we call it?', response_kind='text', placeholder='name'." ;;
  *) echo "bad KIND=$KIND" >&2; exit 2 ;;
esac

# 1) Phone side: poll the pair log for the deep link, drive the REAL PWA to answer.
( cd frontend && PAIR_LOG="$LOG" KIND="$KIND" SHOT="$PWD/e2e/pwa-approve.png" \
    node e2e/pwa-approve.mjs ) > "$PHONE_OUT" 2>&1 &
PHONE_PID=$!

PROMPT="You have an MCP tool called request_approval from the 'askhuman' server. Call it exactly once to ask a human for approval. ${ASK} Wait for the tool result and then tell me the decision verbatim (the approved/choice/text value). Do not run any shell commands or do anything else."

echo "agent: $AGENT_CLI  ·  kind: $KIND"
echo "launcher: $LAUNCH   pair-log: $LOG"

# 2) Agent side: a real agent CLI invokes the tool over MCP stdio.
case "$AGENT_CLI" in
  codex)
    # Scoped sandbox (NOT the blanket --dangerously bypass): workspace-write lets the MCP
    # server write the pair-log; network_access lets it dial the local relay. The model
    # still can't run shell or touch anything outside the workspace. env passes the log path
    # to the launcher (codex spawns it with only the configured env).
    codex exec \
      --skip-git-repo-check \
      -s workspace-write \
      -c 'sandbox_workspace_write.network_access=true' \
      -c 'approval_policy="never"' \
      -c "mcp_servers.askhuman.command=\"$LAUNCH\"" \
      -c "mcp_servers.askhuman.env.AAH_PAIR_LOG=\"$LOG\"" \
      -c 'mcp_servers.askhuman.startup_timeout_sec=20' \
      -c 'mcp_servers.askhuman.tool_timeout_sec=120' \
      -c 'model_reasoning_effort="low"' \
      "$PROMPT" > "$AGENT_OUT" 2>&1 || true ;;
  cursor)
    # Reads the project .cursor/mcp.json (askhuman → localhost launcher). --approve-mcps
    # auto-approves the MCP tool call (the gate that blocks headless codex); --trust makes
    # the workspace usable in headless mode; --force avoids approval prompts hanging.
    cursor-agent -p --output-format text \
      --approve-mcps --trust --force \
      "$PROMPT" > "$AGENT_OUT" 2>&1 || true ;;
  direct)
    # Deterministic control: a minimal MCP stdio client (no LLM, no API key) calls the
    # tool directly. Same relay + PWA path; CI-friendly because nothing is non-deterministic.
    LAUNCH="$LAUNCH" KIND="$KIND" AAH_PAIR_LOG="$LOG" node scripts/mcp-call.mjs > "$AGENT_OUT" 2>&1 || true ;;
  *) echo "bad AGENT_CLI=$AGENT_CLI" >&2; kill "$PHONE_PID" 2>/dev/null || true; exit 2 ;;
esac

wait "$PHONE_PID" 2>/dev/null || true

echo; echo "=== PHONE (PWA) ==="; cat "$PHONE_OUT"
echo; echo "=== AGENT ($AGENT_CLI) tail ==="; tail -25 "$AGENT_OUT"
echo; echo "=== PAIRING LOG (relay-blind: agent only sees pairing display) ==="; tail -6 "$LOG"

# 3) Proof: the agent reported the real decision (only obtainable via the sealed round trip).
case "$KIND" in
  yesno)  PAT='approved|true' ;;
  choice) PAT='Proceed' ;;
  text)   PAT='ok|release|name' ;;
esac
echo; if grep -qiE "$PAT" "$AGENT_OUT" && grep -q "answered the request" "$PHONE_OUT"; then
  echo "AGENT-E2E PASSED (kind=$KIND) — real agent CLI got the human's sealed decision through the kind relay."
else
  echo "AGENT-E2E FAILED (kind=$KIND) — see outputs above."; exit 1
fi
