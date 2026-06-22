//go:build integration

package agent

import (
	"context"
	"io"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestIntegrationMCPRequestApproval drives the request_approval tool over the
// go-sdk in-memory transport: a real relay + phone-stub auto-approve, and the
// MCP client asserts the returned structured decision.
func TestIntegrationMCPRequestApproval(t *testing.T) {
	relayURL := startRelay(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	ag, err := New(Config{RelayURL: relayURL, AgentName: "test-agent"})
	require.NoError(t, err)

	h := NewMCPServer(ag, io.Discard)

	// The agent generates the room/code only when the tool is first called.
	// Pre-generate the pairing, inject it, and stand up the phone-stub so it
	// is waiting in the same room when the handler pairs.
	p, err := ag.NewPairing()
	require.NoError(t, err)
	h.SetPairFunc(func(ctx context.Context) error { return ag.Pair(ctx, p) })

	// Connect server and client over the in-memory transport.
	st, ct := mcp.NewInMemoryTransports()
	serverSession, err := h.Server().Connect(ctx, st, nil)
	require.NoError(t, err)
	defer serverSession.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "v0"}, nil)
	clientSession, err := client.Connect(ctx, ct, nil)
	require.NoError(t, err)
	defer clientSession.Close()

	// Stand up the phone-stub waiting in the same room the handler will pair.
	phone, err := dialPhone(ctx, relayURL, p.RoomID, p.Canon)
	require.NoError(t, err)
	defer phone.conn.CloseNow()
	done := phone.runPhone(ctx)

	res, err := clientSession.CallTool(ctx, &mcp.CallToolParams{
		Name: "request_approval",
		Arguments: map[string]any{
			"title":         "Production deploy",
			"category":      "deploy",
			"summary":       "Deploy v2.3.1?",
			"response_kind": "yesno",
			"expires_in_s":  60,
		},
	})
	require.NoError(t, err)
	require.False(t, res.IsError, "tool returned error: %+v", res.Content)

	out, ok := res.StructuredContent.(map[string]any)
	require.True(t, ok, "structured content: %T", res.StructuredContent)
	approved, ok := out["approved"].(bool)
	require.True(t, ok, "approved field: %+v", out)
	assert.True(t, approved)

	require.NoError(t, <-done)
}
