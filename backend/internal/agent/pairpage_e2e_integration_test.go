//go:build integration

package agent

import (
	"context"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/askahuman/askahuman/backend/pkg/paircode"
)

// TestIntegrationMCPPairPageE2E drives request_approval end to end with the REAL
// loopback pair page active (only the browser-open is stubbed): a live relay +
// phone-stub complete the SPAKE2 handshake, and the test asserts
//  1. the structured decision came back approved (the page did not break pairing),
//  2. the page served the freshly minted code in its BODY at the nonce path, and
//  3. the page's /status flipped to paired — the exact signal that turns the tab
//     "connected".
//
// It also proves the privacy invariant in passing: the code is read back from the
// loopback page, NOT from any MCP tool result.
func TestIntegrationMCPPairPageE2E(t *testing.T) {
	relayURL := startRelay(t)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	ag, err := New(Config{RelayURL: relayURL, AgentName: "e2e"})
	require.NoError(t, err)

	h := NewMCPServer(ag, io.Discard)

	// Swap the production surface (which opens a real browser) for one that stands
	// up the REAL page server headlessly AND launches the phone-stub in the room
	// the agent just minted — so pairOnce's normal mint->surface->Pair path runs
	// and we exercise the actual page the agent serves. The callback runs on the
	// server's goroutine, so it must NOT use require/t.Fatal: errors are funnelled
	// to phoneErr, which the test goroutine checks.
	var pagePtr atomic.Pointer[pairPage]
	var phonePtr atomic.Pointer[phoneStub]
	phoneErr := make(chan error, 1)
	h.surface = func(display string) (*pairPage, error) {
		pg, perr := newPairPage(display)
		if perr != nil {
			return nil, perr
		}
		pagePtr.Store(pg)
		canon, cerr := paircode.Canonicalize(display)
		if cerr != nil {
			phoneErr <- cerr
			return pg, nil
		}
		room, rerr := paircode.RoomFromCode(canon)
		if rerr != nil {
			phoneErr <- rerr
			return pg, nil
		}
		phone, derr := dialPhone(ctx, relayURL, room, canon)
		if derr != nil {
			phoneErr <- derr
			return pg, nil
		}
		phonePtr.Store(phone)
		go func() { phoneErr <- <-phone.runPhone(ctx) }()
		return pg, nil
	}

	st, ct := mcp.NewInMemoryTransports()
	serverSession, err := h.Server().Connect(ctx, st, nil)
	require.NoError(t, err)
	defer serverSession.Close()

	client := mcp.NewClient(&mcp.Implementation{Name: "e2e-client", Version: "v0"}, nil)
	clientSession, err := client.Connect(ctx, ct, nil)
	require.NoError(t, err)
	defer clientSession.Close()

	res, err := clientSession.CallTool(ctx, &mcp.CallToolParams{
		Name: "request_approval",
		Arguments: map[string]any{
			"title":         "Production deploy",
			"summary":       "Deploy v2.3.1?",
			"response_kind": "yesno",
			"expires_in_s":  60,
		},
	})
	require.NoError(t, err)
	require.False(t, res.IsError, "tool returned error: %+v", res.Content)

	out, ok := res.StructuredContent.(map[string]any)
	require.True(t, ok, "structured content: %T", res.StructuredContent)
	approved, _ := out["approved"].(bool)
	assert.True(t, approved, "decision must be approved")

	require.NoError(t, <-phoneErr, "phone-stub pair+answer")
	if p := phonePtr.Load(); p != nil {
		defer p.conn.CloseNow()
	}

	// The page the agent served must carry the code in its BODY (never an MCP
	// result), and its /status must report paired — the flip that drives the tab
	// to "connected". Both are read within the post-pair grace window.
	page := pagePtr.Load()
	require.NotNil(t, page, "surface must have created a page")

	status, body, _ := get(t, page.url)
	require.Equal(t, http.StatusOK, status)
	assert.Contains(t, body, page.display, "page body must show the minted code")

	status, statusBody, _ := get(t, page.url+"/status")
	require.Equal(t, http.StatusOK, status)
	assert.JSONEq(t, `{"paired":true}`, statusBody)
}
