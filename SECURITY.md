# Security Policy

**ask-a-human** lets your AI agent ask a human — on your phone. End-to-end encrypted, no accounts, no database.

## Threat model

The architecture is deliberately split so no single piece holds everything:

- **The relay is content-blind.** It only ever sees `base64(nonce‖ciphertext)` and which room talks to which. No database, RAM-only — restart means re-pair. It cannot read messages, and it is open-source and self-hostable (override `--relay` / `--public-relay`).
- **The agent runs locally**, next to your editor (Cursor/Claude/Codex) via `npx @askahuman/mcp serve`. It holds the SPAKE2-derived key and the plaintext. It exposes ONE tool, `request_approval`, which blocks until a human answers (approve / decline / choose / reply). It never auto-approves.
- **The phone PWA** (https://ask-a-human.ai/app) is the only other key-holder.

Pairing uses a Magic-Wormhole-style SPAKE2 handshake: a short code becomes a strong shared key, so the relay cannot MITM the exchange.

Because the relay can't read anything, the **highest-value targets are the PWA and the pairing channel**:

- **The PWA** — XSS or clickjacking against the PWA defeats end-to-end encryption by reaching plaintext or hijacking the human's decision.
- **The pairing channel** — an attacker who breaks the SPAKE2 handshake or tricks a user through a malicious code could insert themselves between agent and human.

Reports touching these areas are especially valuable.

## Supported versions

We support the latest published `@askahuman/mcp` (npm) and the latest release. Please reproduce on the latest version before reporting.

## Reporting a vulnerability

**Primary:** Use GitHub private vulnerability reporting — click **"Report a vulnerability"** under the repo **Security** tab (GitHub Security Advisories) at https://github.com/askahuman/askahuman.

**Secondary:** Email security@ask-a-human.ai.

Please include steps to reproduce, affected version, and impact. Do **not** open a public issue for security reports.

## Our commitment

- We acknowledge reports quickly.
- There is **no bug bounty** — we cannot offer monetary rewards.
- Once a report is confirmed, we aim to patch and cut a release promptly.
- We prefer **coordinated disclosure**: please give us a reasonable window before going public.

## Out of scope

- Misconfiguration of a self-hosted relay or web deployment.
- Social engineering of the human approver (e.g. tricking them into approving).
- Denial of service against your own local agent or self-hosted relay.
- Vulnerabilities in third-party dependencies without a demonstrated impact on ask-a-human.
- Issues requiring a compromised device, malicious browser extension, or physical access to an unlocked phone.
