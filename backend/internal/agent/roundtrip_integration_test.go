//go:build integration

package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/askahuman/askahuman/backend/internal/relay"
	"github.com/askahuman/askahuman/backend/pkg/sealedbox"
	"github.com/askahuman/askahuman/backend/pkg/spake2"
	"github.com/askahuman/askahuman/backend/pkg/wire"
)

// startRelay starts the relay over httptest and returns its ws:// base URL.
func startRelay(t *testing.T) string {
	t.Helper()
	// AAH_RELAY_URL points the integration suite at an already-running relay
	// (e.g. the one deployed in kind) instead of an in-process httptest relay,
	// turning these same tests into a live end-to-end check. Default: hermetic.
	if u := os.Getenv("AAH_RELAY_URL"); u != "" {
		return u
	}
	srv := httptest.NewServer(relay.New().Mux())
	t.Cleanup(srv.Close)
	return strings.Replace(srv.URL, "http", "ws", 1) + "/ws"
}

// phoneStub is the B-side. Its methods return errors (never call t/require)
// so they are safe to run in a goroutine; the test goroutine checks the
// single error reported via its run channel. It records every raw frame the
// relay forwarded to B for the blindness assertion.
type phoneStub struct {
	conn     *websocket.Conn
	hs       *spake2.State
	key      []byte
	received [][]byte
}

func dialPhone(ctx context.Context, relayURL, roomID, code string) (*phoneStub, error) {
	c, _, err := websocket.Dial(ctx, relayURL+"?room="+roomID, nil)
	if err != nil {
		return nil, err
	}
	return &phoneStub{conn: c, hs: spake2.NewB(code)}, nil
}

func (p *phoneStub) read(ctx context.Context) (envelope, error) {
	typ, data, err := p.conn.Read(ctx)
	if err != nil {
		return envelope{}, err
	}
	if typ != websocket.MessageText {
		return p.read(ctx)
	}
	p.received = append(p.received, append([]byte(nil), data...))
	var env envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return envelope{}, err
	}
	return env, nil
}

func (p *phoneStub) write(ctx context.Context, env envelope) error {
	b, err := json.Marshal(env)
	if err != nil {
		return err
	}
	return p.conn.Write(ctx, websocket.MessageText, b)
}

// pair runs the SPAKE2 B-side until the session key is set.
func (p *phoneStub) pair(ctx context.Context) error {
	myPake, err := p.hs.Start()
	if err != nil {
		return err
	}
	if err := p.write(ctx, envelope{Pake: base64.StdEncoding.EncodeToString(myPake)}); err != nil {
		return err
	}

	var pendingConfirm []byte
	finished := false
	for p.key == nil {
		env, err := p.read(ctx)
		if err != nil {
			return err
		}
		switch {
		case env.Relay == wire.SignalPeerJoined:
			// Re-send the same pake: ours may have been dropped before the
			// agent joined.
			if werr := p.write(ctx, envelope{Pake: base64.StdEncoding.EncodeToString(myPake)}); werr != nil {
				return werr
			}
			continue
		case env.Relay != "":
			continue
		case env.Pake != "":
			if finished {
				continue // duplicate pake after a resend; already finished.
			}
			peer, derr := base64.StdEncoding.DecodeString(env.Pake)
			if derr != nil {
				return derr
			}
			_, confirm, ferr := p.hs.Finish(peer)
			if ferr != nil {
				return ferr
			}
			finished = true
			if werr := p.write(ctx, envelope{Confirm: base64.StdEncoding.EncodeToString(confirm)}); werr != nil {
				return werr
			}
			if pendingConfirm != nil {
				if cerr := p.hs.Confirm(pendingConfirm); cerr != nil {
					return cerr
				}
				p.key = p.hs.SessionKey()
			}
		case env.Confirm != "":
			peerConfirm, derr := base64.StdEncoding.DecodeString(env.Confirm)
			if derr != nil {
				return derr
			}
			if !finished {
				pendingConfirm = peerConfirm
				continue
			}
			if cerr := p.hs.Confirm(peerConfirm); cerr != nil {
				return cerr
			}
			p.key = p.hs.SessionKey()
		}
	}
	return nil
}

// answer reads request boxes and replies once with the auto-answer for the
// request's kind (yesno=approve, choice=first, text="ok").
func (p *phoneStub) answer(ctx context.Context) error {
	for {
		env, err := p.read(ctx)
		if err != nil {
			return err
		}
		if env.Box == "" {
			continue
		}
		plain, err := sealedbox.Open(p.key, env.Box)
		if err != nil {
			return err
		}
		var req wire.Request
		if err := json.Unmarshal(plain, &req); err != nil {
			return err
		}
		if req.Kind == wire.KindVAPIDKey {
			continue // agent's sealed VAPID public-key frame; not a request
		}
		if req.Kind != wire.KindRequest {
			return fmt.Errorf("phone: unexpected kind %q", req.Kind)
		}

		dec := wire.Decision{Kind: wire.KindDecision, ID: req.ID}
		switch req.Response.Kind {
		case wire.ResponseYesNo:
			yes := true
			dec.Result.Approved = &yes
		case wire.ResponseChoice:
			if len(req.Response.Options) == 0 {
				return fmt.Errorf("phone: choice with no options")
			}
			dec.Result.Choice = req.Response.Options[0]
		case wire.ResponseText:
			dec.Result.Text = "ok"
		}
		out, err := json.Marshal(dec)
		if err != nil {
			return err
		}
		box, err := sealedbox.Seal(p.key, out)
		if err != nil {
			return err
		}
		return p.write(ctx, envelope{Box: box})
	}
}

// runPhone pairs then answers, reporting the first error (or nil) on done.
func (p *phoneStub) runPhone(ctx context.Context) <-chan error {
	done := make(chan error, 1)
	go func() {
		if err := p.pair(ctx); err != nil {
			done <- err
			return
		}
		done <- p.answer(ctx)
	}()
	return done
}

func TestIntegrationRoundTrip(t *testing.T) {
	relayURL := startRelay(t)

	cases := []struct {
		name string
		req  wire.Request
		want func(*testing.T, wire.Decision)
	}{
		{
			name: "yesno",
			req:  wire.Request{ID: "r_yes", Title: "deploy", Summary: "go?", Response: wire.Response{Kind: wire.ResponseYesNo}},
			want: func(t *testing.T, d wire.Decision) {
				require.NotNil(t, d.Result.Approved)
				assert.True(t, *d.Result.Approved)
			},
		},
		{
			name: "choice",
			req:  wire.Request{ID: "r_ch", Title: "pick", Summary: "which?", Response: wire.Response{Kind: wire.ResponseChoice, Options: []string{"Proceed", "Hold"}}},
			want: func(t *testing.T, d wire.Decision) {
				assert.Equal(t, "Proceed", d.Result.Choice)
			},
		},
		{
			name: "text",
			req:  wire.Request{ID: "r_tx", Title: "amount", Summary: "how much?", Response: wire.Response{Kind: wire.ResponseText, MaxLen: 100}},
			want: func(t *testing.T, d wire.Decision) {
				assert.Equal(t, "ok", d.Result.Text)
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()

			ag, err := New(Config{RelayURL: relayURL})
			require.NoError(t, err)
			p, err := ag.NewPairing()
			require.NoError(t, err)

			phone, err := dialPhone(ctx, relayURL, p.RoomID, p.Canon)
			require.NoError(t, err)
			defer phone.conn.CloseNow()
			done := phone.runPhone(ctx)

			require.NoError(t, ag.Pair(ctx, p))
			dec, err := ag.Ask(ctx, tc.req)
			require.NoError(t, err)
			tc.want(t, dec)
			require.NoError(t, <-done)
		})
	}
}

// TestIntegrationRelayBlindness asserts every frame the relay forwarded to
// the phone is one of pake/confirm/box/_relay, and that a box frame's bytes
// cannot be JSON-unmarshalled into a populated wire.Request/Decision: the
// relay only ever sees opaque ciphertext.
func TestIntegrationRelayBlindness(t *testing.T) {
	relayURL := startRelay(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	ag, err := New(Config{RelayURL: relayURL})
	require.NoError(t, err)
	p, err := ag.NewPairing()
	require.NoError(t, err)

	phone, err := dialPhone(ctx, relayURL, p.RoomID, p.Canon)
	require.NoError(t, err)
	defer phone.conn.CloseNow()
	done := phone.runPhone(ctx)

	require.NoError(t, ag.Pair(ctx, p))
	_, err = ag.Ask(ctx, wire.Request{ID: "r_blind", Title: "t", Summary: "s", Response: wire.Response{Kind: wire.ResponseYesNo}})
	require.NoError(t, err)
	require.NoError(t, <-done)

	sawBox := false
	for _, raw := range phone.received {
		var env envelope
		require.NoError(t, json.Unmarshal(raw, &env))

		isAppOrControl := env.Pake != "" || env.Confirm != "" || env.Box != "" || env.Relay != ""
		assert.True(t, isAppOrControl, "unexpected frame shape: %s", raw)

		if env.Box == "" {
			continue
		}
		sawBox = true

		ct, derr := base64.StdEncoding.DecodeString(env.Box)
		require.NoError(t, derr)

		var req wire.Request
		_ = json.Unmarshal(ct, &req)
		assert.Empty(t, req.Kind, "ciphertext leaked a request")
		assert.Empty(t, req.ID)

		var dec wire.Decision
		_ = json.Unmarshal(ct, &dec)
		assert.Empty(t, dec.Kind, "ciphertext leaked a decision")

		assert.NotContains(t, string(ct), `"kind"`)
		assert.NotContains(t, string(ct), `"approved"`)
	}
	assert.True(t, sawBox, "expected at least one box frame to inspect")
}
