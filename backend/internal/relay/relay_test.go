package relay

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/askahuman/askahuman/backend/pkg/wire"
)

// Valid 16-hex room ids (the format agent.newRoomID produces). Tests must use
// well-formed ids now that the relay validates them.
const (
	roomA = "0123456789abcdef"
	roomB = "fedcba9876543210"
	roomC = "00112233445566aa"
)

// dialRoom opens a WebSocket to the relay's /ws?room=<id>.
func dialRoom(t *testing.T, base, room string) *websocket.Conn {
	t.Helper()
	u := strings.Replace(base, "http", "ws", 1) + "/ws?room=" + room
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	//nolint:bodyclose // successful 101 upgrade: coder/websocket owns the response; only the error path has a body to close.
	c, _, err := websocket.Dial(ctx, u, nil)
	require.NoError(t, err)
	return c
}

// readFrame reads one text frame and decodes it as a wire.Frame.
func readFrame(t *testing.T, c *websocket.Conn) wire.Frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	typ, data, err := c.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, websocket.MessageText, typ)
	var f wire.Frame
	require.NoError(t, json.Unmarshal(data, &f))
	return f
}

func writeText(t *testing.T, c *websocket.Conn, s string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	require.NoError(t, c.Write(ctx, websocket.MessageText, []byte(s)))
}

func newServer(t *testing.T) string {
	t.Helper()
	r := New()
	srv := httptest.NewServer(r.Mux())
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestHealthz(t *testing.T) {
	base := newServer(t)
	resp, err := http.Get(base + "/healthz")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestForwardVerbatim(t *testing.T) {
	base := newServer(t)
	a := dialRoom(t, base, roomA)
	defer a.CloseNow()
	b := dialRoom(t, base, roomA)
	defer b.CloseNow()

	// Both sides learn the peer is present: A gets peer_joined when B joins,
	// and B (the newcomer) gets peer_joined because A was already there.
	assert.Equal(t, wire.SignalPeerJoined, readFrame(t, a).Relay)
	assert.Equal(t, wire.SignalPeerJoined, readFrame(t, b).Relay)

	// A sends an opaque box; B receives the exact same bytes.
	const payload = `{"box":"dGVzdC1jaXBoZXJ0ZXh0"}`
	writeText(t, a, payload)

	got := readFrame(t, b)
	assert.Equal(t, "dGVzdC1jaXBoZXJ0ZXh0", got.Box)
	assert.Empty(t, got.Relay)
}

func TestUndeliverableWhenAlone(t *testing.T) {
	base := newServer(t)
	a := dialRoom(t, base, roomA)
	defer a.CloseNow()

	writeText(t, a, `{"box":"YWJj"}`)
	f := readFrame(t, a)
	assert.Equal(t, wire.SignalUndeliverable, f.Relay)
}

func TestPeerLeftSignal(t *testing.T) {
	base := newServer(t)
	a := dialRoom(t, base, roomA)
	defer a.CloseNow()
	b := dialRoom(t, base, roomA)

	// Drain A's peer_joined.
	assert.Equal(t, wire.SignalPeerJoined, readFrame(t, a).Relay)

	require.NoError(t, b.Close(websocket.StatusNormalClosure, "bye"))
	assert.Equal(t, wire.SignalPeerLeft, readFrame(t, a).Relay)
}

func TestThirdJoinClosed4001(t *testing.T) {
	base := newServer(t)
	a := dialRoom(t, base, roomA)
	defer a.CloseNow()
	b := dialRoom(t, base, roomA)
	defer b.CloseNow()
	assert.Equal(t, wire.SignalPeerJoined, readFrame(t, a).Relay)

	c := dialRoom(t, base, roomA)
	defer c.CloseNow()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err := c.Read(ctx)
	require.Error(t, err)
	var ce websocket.CloseError
	require.ErrorAs(t, err, &ce)
	assert.Equal(t, StatusRoomFull, ce.Code)
}

func TestSeparateRoomsIsolated(t *testing.T) {
	base := newServer(t)
	a := dialRoom(t, base, roomA)
	defer a.CloseNow()
	b := dialRoom(t, base, roomB)
	defer b.CloseNow()

	// a is alone in roomA -> its frame is undeliverable, never reaches b.
	writeText(t, a, `{"box":"aGVsbG8="}`)
	assert.Equal(t, wire.SignalUndeliverable, readFrame(t, a).Relay)
}

func TestMissingRoomBadRequest(t *testing.T) {
	base := newServer(t)
	u := strings.Replace(base, "http", "ws", 1) + "/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, u, nil)
	require.Error(t, err)
	if resp != nil {
		defer resp.Body.Close()
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	}
}

func TestValidRoomID(t *testing.T) {
	cases := []struct {
		name string
		id   string
		want bool
	}{
		{"16 lower hex (real)", roomA, true},
		{"16 mixed-case hex", "0123456789ABCDef", true},
		{"empty", "", false},
		{"too short", "abc", false},
		{"too long", roomA + "0", false},
		{"non-hex char", "0123456789abcdeg", false},
		{"path traversal", "../../../etc/pas", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, validRoomID(tc.id))
		})
	}
}

func TestInvalidRoomBadRequest(t *testing.T) {
	base := newServer(t)
	// A malformed room id is rejected at the HTTP layer before the upgrade.
	u := strings.Replace(base, "http", "ws", 1) + "/ws?room=not-hex"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, u, nil)
	require.Error(t, err)
	if resp != nil {
		defer resp.Body.Close()
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	}
}

func TestClientRelayFrameRejected(t *testing.T) {
	base := newServer(t)
	a := dialRoom(t, base, roomA)
	defer a.CloseNow()
	b := dialRoom(t, base, roomA)
	defer b.CloseNow()
	assert.Equal(t, wire.SignalPeerJoined, readFrame(t, a).Relay)
	assert.Equal(t, wire.SignalPeerJoined, readFrame(t, b).Relay)

	// A maliciously injects a relay control signal. The relay must NOT forward
	// it to B; it closes A with a policy-violation code.
	writeText(t, a, `{"_relay":"peer_left"}`)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err := a.Read(ctx)
	require.Error(t, err)
	var ce websocket.CloseError
	require.ErrorAs(t, err, &ce)
	assert.Equal(t, StatusPolicyViolation, ce.Code)
}

func TestRoomCapRejected(t *testing.T) {
	// Shrink the global room cap for this test, then restore it.
	orig := maxRooms
	maxRooms = 1
	t.Cleanup(func() { maxRooms = orig })

	base := newServer(t)
	a := dialRoom(t, base, roomA) // fills the single room slot
	defer a.CloseNow()

	// A second, different room exceeds the cap and is closed as overloaded.
	c := dialRoom(t, base, roomB)
	defer c.CloseNow()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err := c.Read(ctx)
	require.Error(t, err)
	var ce websocket.CloseError
	require.ErrorAs(t, err, &ce)
	assert.Equal(t, StatusOverloaded, ce.Code)
}

func TestPerIPCapRejected(t *testing.T) {
	orig := maxConnsPerIP
	maxConnsPerIP = 1
	t.Cleanup(func() { maxConnsPerIP = orig })

	base := newServer(t)
	a := dialRoom(t, base, roomA) // uses the single per-IP slot (loopback)
	defer a.CloseNow()

	// Second connection from the same IP is rejected at the HTTP layer
	// (503) before any WebSocket is allocated.
	u := strings.Replace(base, "http", "ws", 1) + "/ws?room=" + roomC
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, u, nil)
	require.Error(t, err)
	if resp != nil {
		defer resp.Body.Close()
		assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
	}
}

// TestClientIPExtraction exercises the per-IP cap key derivation directly (no
// HTTP server): when trustProxy is off, RemoteAddr wins and any client XFF is
// ignored; when on, the rightmost (trusted-LB-appended) XFF hop wins, never a
// leftmost client-spoofable one. Toggles the package-level trustProxy with
// save/restore (mirrors the maxConnsPerIP pattern above).
func TestClientIPExtraction(t *testing.T) {
	cases := []struct {
		name   string
		trust  bool
		remote string
		xff    string // "" => header absent
		want   string
	}{
		{"no-trust ignores absent XFF", false, "1.2.3.4:5678", "", "1.2.3.4"},
		{"no-trust ignores present XFF", false, "1.2.3.4:5678", "9.9.9.9", "1.2.3.4"},
		{"trust single hop", true, "10.0.0.1:5678", "9.9.9.9", "9.9.9.9"},
		{"trust rightmost wins over leftmost spoof", true, "10.0.0.1:0", "spoofed, 8.8.8.8, 9.9.9.9", "9.9.9.9"},
		{"trust falls back when XFF unparseable", true, "10.0.0.1:5678", "not-an-ip", "10.0.0.1"},
		{"trust falls back on empty XFF", true, "10.0.0.1:5678", "", "10.0.0.1"},
		{"trust trims whitespace", true, "10.0.0.1:5678", "  9.9.9.9  ", "9.9.9.9"},
		{"trust tolerates host:port hop", true, "10.0.0.1:5678", "9.9.9.9:443", "9.9.9.9"},
		{"no-trust RemoteAddr without port", false, "1.2.3.4", "", "1.2.3.4"},
	}
	orig := trustProxy
	t.Cleanup(func() { trustProxy = orig })
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			trustProxy = tc.trust
			req := &http.Request{RemoteAddr: tc.remote, Header: http.Header{}}
			if tc.xff != "" {
				req.Header.Set("X-Forwarded-For", tc.xff)
			}
			assert.Equal(t, tc.want, clientIP(req))
		})
	}
}
