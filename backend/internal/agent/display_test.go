package agent

import (
	"bytes"
	"context"
	"io"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func pairStatusText(t *testing.T, h *MCPServer) string {
	t.Helper()
	res, _, err := h.pairStatus(context.Background(), nil, PairStatusInput{})
	require.NoError(t, err)
	require.Len(t, res.Content, 1)
	tc, ok := res.Content[0].(*mcp.TextContent)
	require.True(t, ok, "content must be TextContent")
	return tc.Text
}

func TestPairStatusNoPairing(t *testing.T) {
	ag, err := New(Config{})
	require.NoError(t, err)
	h := NewMCPServer(ag, io.Discard)

	got := pairStatusText(t, h)
	assert.Contains(t, got, "no active pairing", "must report no pairing without minting one")
	assert.False(t, h.havePairing, "pair_status must NOT mint a pairing")
}

func TestPairStatusNeverLeaksSecret(t *testing.T) {
	ag, err := New(Config{})
	require.NoError(t, err)
	h := NewMCPServer(ag, io.Discard)
	h.pairing = Pairing{RoomID: "deadbeefdeadbeef", Display: "WISP-OT3R", Canon: "WISPOT3R"}
	h.havePairing = true

	got := pairStatusText(t, h)
	// SECURITY: the MCP result must carry NO secret material (code/room).
	assert.NotContains(t, got, "WISP-OT3R", "must NOT leak the displayed code")
	assert.NotContains(t, got, "WISPOT3R", "must NOT leak the canonical code")
	assert.NotContains(t, got, "deadbeefdeadbeef", "must NOT leak the room id")
	assert.Contains(t, got, "type the code shown in the agent terminal",
		"must give a generic out-of-band instruction")
}

func TestPrintCode(t *testing.T) {
	var buf bytes.Buffer
	PrintCode(&buf, "4F2K-9QHR")
	out := buf.String()

	// One clear human line: the grouped code + where to enter it. No QR, no
	// deep link, no room id (it is derivable from the code).
	assert.Contains(t, out, "Pairing code: 4F2K-9QHR")
	assert.Contains(t, out, "https://ask-a-human.ai/app")
	assert.NotContains(t, out, "#p=", "no deep link with a secret fragment")
	assert.NotContains(t, out, "?p=", "no scan URL with a secret query")
	assert.NotContains(t, out, "█", "no QR block")
}
