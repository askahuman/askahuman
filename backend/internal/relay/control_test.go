package relay

import (
	"context"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/askahuman/askahuman/backend/pkg/wire"
)

func TestReservedControlKeyCannotHideBehindApplicationFields(t *testing.T) {
	frames := map[string]string{
		"normal signal":          `{"_relay":"peer_joined"}`,
		"wrong type box":         `{"_relay":"peer_joined","box":123}`,
		"mixed case box":         `{"_relay":"peer_joined","Box":123}`,
		"wrong type pake":        `{"pake":true,"_relay":"peer_joined"}`,
		"duplicate box":          `{"Box":123,"box":"opaque","_relay":"peer_joined"}`,
		"duplicate control":      `{"_relay":"peer_joined","_relay":""}`,
		"duplicate null control": `{"_relay":"peer_joined","_relay":null}`,
		"null then control":      `{"_relay":null,"_relay":"peer_joined"}`,
		"empty control":          `{"_relay":""}`,
		"null control":           `{"_relay":null}`,
		"numeric control":        `{"_relay":3}`,
		"object control":         `{"_relay":{"value":"peer_joined"}}`,
		"mixed case control":     `{"_ReLaY":"peer_joined"}`,
		"escaped control key":    `{"\u005frelay":"peer_joined"}`,
	}
	for name, payload := range frames {
		t.Run(name, func(t *testing.T) {
			require.True(t, relaySet([]byte(payload)))
			base := newServer(t)
			a := dialRoom(t, base, roomA)
			defer a.CloseNow()
			b := dialRoom(t, base, roomA)
			defer b.CloseNow()
			require.Equal(t, wire.SignalPeerJoined, readFrame(t, a).Relay)
			require.Equal(t, wire.SignalPeerJoined, readFrame(t, b).Relay)
			writeText(t, a, payload)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_, _, err := a.Read(ctx)
			require.Equal(t, StatusPolicyViolation, websocket.CloseStatus(err))
			// The survivor sees only the server's actual disconnect signal,
			// never the client-supplied frame (including ignored/empty values).
			assert.Equal(t, wire.Frame{Relay: wire.SignalPeerLeft}, readFrame(t, b))
		})
	}
}

func TestApplicationFramesRemainOpaque(t *testing.T) {
	frames := []string{
		`{"box":"opaque"}`,
		`{"Box":123,"pake":true}`,
		`{"nested":{"_relay":"peer_left"}}`,
		`{"box":"a string containing _relay"}`,
		`{"box":"one","box":"two"}`,
		`["_relay"]`,
		`null`,
		`not json`,
	}
	base := newServer(t)
	a := dialRoom(t, base, roomA)
	defer a.CloseNow()
	b := dialRoom(t, base, roomA)
	defer b.CloseNow()
	require.Equal(t, wire.SignalPeerJoined, readFrame(t, a).Relay)
	require.Equal(t, wire.SignalPeerJoined, readFrame(t, b).Relay)
	for _, payload := range frames {
		require.False(t, relaySet([]byte(payload)), payload)
		writeText(t, a, payload)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, data, err := b.Read(ctx)
		cancel()
		require.NoError(t, err)
		assert.Equal(t, payload, string(data))
	}
}
