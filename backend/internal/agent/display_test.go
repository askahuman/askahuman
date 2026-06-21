package agent

import (
	"bytes"
	"context"
	"io"
	"strings"
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
	h := NewMCPServer(ag, "http://web", io.Discard)

	got := pairStatusText(t, h)
	assert.Contains(t, got, "no active pairing", "must report no pairing without minting one")
	assert.False(t, h.havePairing, "pair_status must NOT mint a pairing")
}

func TestPairStatusNeverLeaksSecret(t *testing.T) {
	ag, err := New(Config{})
	require.NoError(t, err)
	h := NewMCPServer(ag, "http://web", io.Discard)
	h.pairing = Pairing{RoomID: "deadbeefdeadbeef", Code: "wisp-otter-9", Payload: "PAYLOAD42"}
	h.havePairing = true

	got := pairStatusText(t, h)
	// SECURITY: the MCP result must carry NO secret material (code/room/payload/link).
	assert.NotContains(t, got, "wisp-otter-9", "must NOT leak the SPAKE2 code")
	assert.NotContains(t, got, "deadbeefdeadbeef", "must NOT leak the room id")
	assert.NotContains(t, got, "PAYLOAD42", "must NOT leak the pairing payload")
	assert.NotContains(t, got, "#p=", "must NOT leak the deep link")
	assert.NotContains(t, got, "?p=", "must NOT leak a scan URL")
	assert.Contains(t, got, "scan the QR", "must give a generic out-of-band instruction")
}

func TestDeepLinkKeepsFragment(t *testing.T) {
	got := DeepLink("http://192.0.2.5:8081", "abc123")
	require.Equal(t, "http://192.0.2.5:8081/app#p=abc123", got)
	assert.NotContains(t, got, "?p=", "secret must be in the fragment, never the query")
}

func TestPrintPairing(t *testing.T) {
	var buf bytes.Buffer
	p := Pairing{RoomID: "deadbeefdeadbeef", Code: "wisp-otter-9", Payload: "PAYLOAD42"}
	PrintPairing(&buf, "http://lan:8081", p)
	out := buf.String()

	// Renders a QR block (the private #p= deep link is encoded in its modules,
	// not printed as text). stderr/log is the out-of-band channel, so code +
	// room + the #p= link are shown here in full.
	assert.Contains(t, out, "█", "must render a QR block")
	assert.Contains(t, out, "link: http://lan:8081/app#p=PAYLOAD42")
	assert.NotContains(t, out, "/?p=", "QR/link must use the private #p= fragment, not ?p=")
	assert.Contains(t, out, "wisp-otter-9")
	assert.Contains(t, out, "deadbeefdeadbeef")
}

func TestNewCode(t *testing.T) {
	code, err := newCode()
	require.NoError(t, err)
	// Format: "XXXX-XXXX" (codeLen symbols + one separator).
	require.Len(t, code, codeLen+1)
	require.Equal(t, byte('-'), code[codeLen/2], "separator at the midpoint")
	for i, c := range code {
		if i == codeLen/2 {
			continue
		}
		assert.True(t, strings.ContainsRune(codeAlphabet, c),
			"symbol %q must be from the unambiguous alphabet", string(c))
	}
}

func TestNewReqID(t *testing.T) {
	a, err := NewReqID()
	require.NoError(t, err)
	b, err := NewReqID()
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(a, "req_"), "must be prefixed req_")
	assert.NotEqual(t, a, b, "random suffix must make ids distinct even back-to-back")
}
