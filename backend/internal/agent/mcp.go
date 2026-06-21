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

// MCPServer wraps an Agent as an MCP server exposing request_approval. It
// pairs lazily on the first tool call, printing the QR/code/deep-link to
// status (stderr in production). The zero value is not usable; call
// NewMCPServer.
type MCPServer struct {
	ag        *Agent
	webOrigin string
	srv       *mcp.Server
	// status is where pairing instructions are printed (stderr by default;
	// io.Discard in tests). stdout is reserved for MCP JSON-RPC.
	status io.Writer
	// pair, when set, overrides the default Agent.Pair (tests inject a stub
	// pairing that completes against the phone-stub without a QR scan).
	pair func(ctx context.Context) error

	mu       sync.Mutex
	pairedCh chan struct{}
	// pairing is the current pairing once pairOnce has minted it; pair_status
	// renders this exact one so the QR shown matches what request_approval is
	// waiting on. mu guards it.
	pairing     Pairing
	havePairing bool
}

// NewMCPServer returns an MCPServer with request_approval registered. The
// handler pairs ag lazily and prints pairing instructions to status (use
// os.Stderr in production, io.Discard in tests). webOrigin is the PWA origin
// for the deep link. Call Server to get the runnable *mcp.Server.
func NewMCPServer(ag *Agent, webOrigin string, status io.Writer) *MCPServer {
	if status == nil {
		status = os.Stderr
	}
	h := &MCPServer{ag: ag, webOrigin: webOrigin, status: status}

	h.srv = mcp.NewServer(&mcp.Implementation{Name: "ask-a-human", Version: "v0"}, nil)
	mcp.AddTool(h.srv, &mcp.Tool{
		Name:        "request_approval",
		Description: "Ask a human to approve/decline/answer on their phone. Blocks until the human responds or it times out; a failure is never returned as approved.",
	}, h.requestApproval)
	mcp.AddTool(h.srv, &mcp.Tool{
		Name:        "pair_status",
		Description: "Report whether the agent is paired, waiting to pair, or idle. Read-only; returns only non-secret status. The pairing QR/code are shown out-of-band (terminal/log), never in this result.",
	}, h.pairStatus)
	return h
}

// Server returns the underlying runnable MCP server.
func (h *MCPServer) Server() *mcp.Server { return h.srv }

// SetPairFunc overrides the pairing step (tests inject a pairing that
// completes against a phone-stub without a real QR scan).
func (h *MCPServer) SetPairFunc(pair func(ctx context.Context) error) { h.pair = pair }

// pairOnce runs the pairing step: the test override if set, else the default
// that pairs the underlying Agent over the relay.
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
	PrintPairing(h.status, h.webOrigin, p)
	_, _ = fmt.Fprintln(h.status, "waiting for phone to pair...")
	if err := h.ag.Pair(ctx, p); err != nil {
		return err
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
// result. It returns ONLY non-secret status: the SPAKE2 code, room id, payload,
// QR, and deep link are secret material and must never enter the MCP transcript
// (a prompt-injected model/client could read them and pair first). The QR/code
// are shown out-of-band (stderr + pair log) by PrintPairing. If no pairing
// exists yet it does NOT mint one (lazy-create starts a SPAKE2 handshake the
// human may never scan).
// ponytail: upgrade path = lazily call ag.NewPairing here and have pairOnce
// reuse h.pairing, so the human can pair proactively before the first approval.
func (h *MCPServer) pairStatus(_ context.Context, _ *mcp.CallToolRequest, _ PairStatusInput) (*mcp.CallToolResult, any, error) {
	h.mu.Lock()
	have := h.havePairing
	paired := h.ag.Paired()
	h.mu.Unlock()

	var text string
	switch {
	case paired:
		text = "paired — the phone is connected; no QR needed."
	case have:
		// SECURITY: never return secret material (code/room/payload/QR/link) in
		// an MCP result; a prompt-injected model/client could read it and pair
		// first. The QR/code stay out-of-band (stderr + pair log). See ADR 0006.
		text = PairingStatusText()
	default:
		text = "no active pairing — call request_approval first to start one."
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}, nil, nil
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
