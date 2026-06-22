package agent

import (
	"context"
	"fmt"
	"io"
	"os"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/askahuman/askahuman/backend/pkg/wire"
)

// ApprovalInput is the request_approval MCP tool's input schema.
type ApprovalInput struct {
	Title        string   `json:"title" jsonschema:"the request title shown on the phone card"`
	Category     string   `json:"category,omitempty" jsonschema:"badge: cash|deploy|data|access|other"`
	Summary      string   `json:"summary" jsonschema:"the human-readable question body"`
	ResponseKind string   `json:"response_kind" jsonschema:"answer shape: yesno|choice|text"`
	Options      []string `json:"options,omitempty" jsonschema:"the choices when response_kind is choice"`
	Placeholder  string   `json:"placeholder,omitempty" jsonschema:"input hint when response_kind is text"`
	MaxLen       int      `json:"max_len,omitempty" jsonschema:"max input length when response_kind is text"`
	ExpiresInS   int      `json:"expires_in_s,omitempty" jsonschema:"optional countdown in seconds"`
}

// ApprovalOutput is the request_approval tool's structured result; exactly
// one field is set, matching the request's response_kind.
type ApprovalOutput struct {
	Approved *bool  `json:"approved,omitempty"`
	Choice   string `json:"choice,omitempty"`
	Text     string `json:"text,omitempty"`
}

// MCPServer wraps an Agent as an MCP server exposing request_approval,
// pair_status, and start_pairing. It pairs lazily on the first request (or
// eagerly via start_pairing), printing the code to status (stderr in
// production). The zero value is not usable; call NewMCPServer.
type MCPServer struct {
	ag  *Agent
	srv *mcp.Server
	// status is where the pairing code is printed (stderr by default;
	// io.Discard in tests). stdout is reserved for MCP JSON-RPC.
	status io.Writer
	// pair, when set, overrides the default Agent.Pair (tests inject a stub
	// pairing that completes against the phone-stub without manual entry).
	pair func(ctx context.Context) error
	// surface, when set, opens a local browser page that shows the pairing code
	// to the human (for clients that bury stderr) and reflects pairing success so
	// the tab self-closes. nil disables it: the code then travels only via
	// PrintCode (stderr). NewMCPServer sets the real opener (openCodePage); the
	// SetPairFunc path returns from pairOnce before it is ever used, so tests
	// stay headless without touching this field.
	surface func(displayCode string) (*pairPage, error)

	mu       sync.Mutex
	pairedCh chan struct{}
	// pairing is the current pairing once pairOnce has minted it. mu guards it.
	pairing     Pairing
	havePairing bool
}

// NewMCPServer returns an MCPServer with request_approval, pair_status, and
// start_pairing registered. The handlers pair ag lazily/eagerly and print the
// pairing code to status (use os.Stderr in production, io.Discard in tests).
// Call Server to get the runnable *mcp.Server.
func NewMCPServer(ag *Agent, status io.Writer) *MCPServer {
	if status == nil {
		status = os.Stderr
	}
	h := &MCPServer{ag: ag, status: status, surface: openCodePage}

	h.srv = mcp.NewServer(&mcp.Implementation{Name: "ask-a-human", Version: "v0"}, nil)
	mcp.AddTool(h.srv, &mcp.Tool{
		Name:        "request_approval",
		Description: "Ask a human to approve/decline/answer on their phone. Blocks until the human responds or it times out; a failure is never returned as approved.",
	}, h.requestApproval)
	mcp.AddTool(h.srv, &mcp.Tool{
		Name:        "pair_status",
		Description: "Report whether the agent is paired, waiting to pair, or idle. Read-only; returns only non-secret status. The pairing code is shown out-of-band (terminal/log), never in this result.",
	}, h.pairStatus)
	mcp.AddTool(h.srv, &mcp.Tool{
		Name:        "start_pairing",
		Description: "Begin pairing with the human's phone. Prints a short code in the agent terminal that the human types into the app; the handshake runs in the background. Returns only non-secret status — the code never appears here.",
	}, h.startPairing)
	return h
}

// Server returns the underlying runnable MCP server.
func (h *MCPServer) Server() *mcp.Server { return h.srv }

// SetPairFunc overrides the pairing step (tests inject a pairing that
// completes against a phone-stub instead of a real phone).
func (h *MCPServer) SetPairFunc(pair func(ctx context.Context) error) { h.pair = pair }

// pairOnce runs one pairing attempt: the test override if set, else mint a
// fresh code, print it (out-of-band, never in a tool result), and run the
// A-side handshake. Each call mints a NEW code and Agent.Pair bounds it by
// pairTTL, so a failed/expired attempt is abandoned and the next pairOnce
// re-mints — capping an attacker to one online SPAKE2 guess per code lifetime.
func (h *MCPServer) pairOnce(ctx context.Context) error {
	if h.pair != nil {
		return h.pair(ctx)
	}
	p, err := h.ag.NewPairing()
	if err != nil {
		return err
	}
	h.mu.Lock()
	h.pairing, h.havePairing = p, true
	h.mu.Unlock()
	PrintCode(h.status, p.Display)
	_, _ = fmt.Fprintln(h.status, "waiting for the phone to enter the code...")

	// Also surface the code on a loopback browser page for clients (Cursor,
	// Codex) that bury stderr. This is a convenience layer ONLY: a failure to
	// open it never fails pairing — the code is already on stderr above.
	var page *pairPage
	if h.surface != nil {
		if pg, perr := h.surface(p.Display); perr != nil {
			_, _ = fmt.Fprintf(h.status, "(could not open the pairing page: %v — use the code above)\n", perr)
		} else {
			page = pg
		}
	}

	if err := h.ag.Pair(ctx, p); err != nil {
		// Abandon this code so a fresh one is minted on the next attempt; never
		// retry the same low-entropy code against a possibly-watching room.
		if page != nil {
			page.close() // stop serving the now-void code at once.
		}
		h.mu.Lock()
		h.havePairing = false
		h.pairing = Pairing{}
		h.mu.Unlock()
		_, _ = fmt.Fprintln(h.status, "pairing failed; the code is now void — call start_pairing for a new one.")
		return err
	}
	if page != nil {
		// Flip the tab to "connected", then let it linger briefly so it polls the
		// state and self-closes before the loopback server shuts down.
		page.markPaired()
		page.closeAfter(pageGrace)
	}
	_, _ = fmt.Fprintln(h.status, "paired.")
	return nil
}

// ensurePaired pairs on first call; concurrent/later calls wait for it.
func (h *MCPServer) ensurePaired(ctx context.Context) error {
	h.mu.Lock()
	if h.ag.Paired() {
		h.mu.Unlock()
		return nil
	}
	if h.pairedCh == nil {
		h.pairedCh = make(chan struct{})
		ch := h.pairedCh
		h.mu.Unlock()
		if err := h.pairOnce(ctx); err != nil {
			h.mu.Lock()
			h.pairedCh = nil // allow a retry on the next call.
			h.mu.Unlock()
			return err
		}
		close(ch)
		return nil
	}
	ch := h.pairedCh
	h.mu.Unlock()
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// PairStatusInput is the pair_status tool's (empty) input schema.
type PairStatusInput struct{}

// pairStatus reports the pairing state (paired / waiting / idle) as a tool
// result. It returns ONLY non-secret status: the SPAKE2 code and room id are
// secret material and must never enter the MCP transcript (a prompt-injected
// model/client could read them and pair first). The code is shown out-of-band
// (stderr + pair log) by PrintCode. It does NOT mint a pairing — use
// start_pairing for that.
func (h *MCPServer) pairStatus(_ context.Context, _ *mcp.CallToolRequest, _ PairStatusInput) (*mcp.CallToolResult, any, error) {
	h.mu.Lock()
	have := h.havePairing
	paired := h.ag.Paired()
	h.mu.Unlock()

	var text string
	switch {
	case paired:
		text = "paired — the phone is connected; no code needed."
	case have:
		// SECURITY: never return secret material (code/room) in an MCP result; a
		// prompt-injected model/client could read it and pair first. The code
		// stays out-of-band (stderr + pair log).
		text = PairingStatusText()
	default:
		text = "no active pairing — call start_pairing to begin one."
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}, nil, nil
}

// StartPairingInput is the start_pairing tool's (empty) input schema.
type StartPairingInput struct{}

// startPairing begins pairing eagerly: it mints+canonicalizes+derives a code,
// PrintCode's it to stderr (out-of-band), and runs the A-side handshake in the
// BACKGROUND so this tool returns immediately. It reuses ensurePaired/pairOnce,
// so a later request_approval awaits the SAME handshake instead of starting a
// second one.
//
// SECURITY: the result is non-secret status ONLY. The code/room never appear
// here — a prompt-injected model/client must not be able to read the pairing
// secret from the MCP transcript and pair first. The code travels only via
// PrintCode (stderr/log).
func (h *MCPServer) startPairing(ctx context.Context, _ *mcp.CallToolRequest, _ StartPairingInput) (*mcp.CallToolResult, any, error) {
	if h.ag.Paired() {
		return textResult("already paired — the phone is connected; no code needed."), nil, nil
	}

	// Kick off the handshake in the background on a context detached from this
	// tool call (the call returns at once; the handshake outlives it, bounded by
	// pairTTL inside Agent.Pair). A concurrent/later request_approval calls
	// ensurePaired and joins this same in-flight attempt.
	go func() {
		if err := h.ensurePaired(context.WithoutCancel(ctx)); err != nil {
			_, _ = fmt.Fprintf(h.status, "pairing error: %v\n", err)
		}
	}()

	return textResult("pairing started — type the code shown in the agent terminal into the app."), nil, nil
}

// textResult wraps a plain string as a non-error tool result.
func textResult(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}
}

// requestApproval is the MCP tool handler.
func (h *MCPServer) requestApproval(ctx context.Context, _ *mcp.CallToolRequest, in ApprovalInput) (*mcp.CallToolResult, ApprovalOutput, error) {
	rk := wire.ResponseKind(in.ResponseKind)
	if !wire.ValidResponseKind(rk) {
		return nil, ApprovalOutput{}, fmt.Errorf("invalid response_kind %q (want yesno|choice|text)", in.ResponseKind)
	}
	if err := h.ensurePaired(ctx); err != nil {
		return nil, ApprovalOutput{}, fmt.Errorf("pairing: %w", err)
	}

	reqID, err := NewReqID()
	if err != nil {
		return nil, ApprovalOutput{}, fmt.Errorf("req id: %w", err)
	}
	req := wire.Request{
		ID:         reqID,
		Title:      in.Title,
		Category:   wire.Category(in.Category),
		Summary:    in.Summary,
		Agent:      h.ag.cfg.AgentName,
		Response:   wire.Response{Kind: rk, Options: in.Options, Placeholder: in.Placeholder, MaxLen: in.MaxLen},
		ExpiresInS: in.ExpiresInS,
	}

	dec, err := h.ag.Ask(ctx, req)
	if err != nil {
		return nil, ApprovalOutput{}, err
	}
	return nil, ApprovalOutput{
		Approved: dec.Result.Approved,
		Choice:   dec.Result.Choice,
		Text:     dec.Result.Text,
	}, nil
}
