//go:build integration

package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
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
	room     string
	signer   *ecdsa.PrivateKey
	spki     string
	agentPub *ecdsa.PublicKey
	key      []byte
	received [][]byte
}

func dialPhone(ctx context.Context, relayURL, roomID, code string) (*phoneStub, error) {
	signer, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	spki, err := wire.PublicSigner(signer)
	if err != nil {
		return nil, err
	}
	c, _, err := websocket.Dial(ctx, relayURL+"?room="+roomID, nil)
	if err != nil {
		return nil, err
	}
	return &phoneStub{conn: c, hs: spake2.NewB(code), room: roomID, signer: signer, spki: spki}, nil
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
	hello, err := json.Marshal(wire.PairHello{Protocol: wire.Protocol, Pake: base64.StdEncoding.EncodeToString(myPake), Signer: p.spki})
	if err != nil {
		return err
	}
	pakeFrame := envelope{Pake: base64.StdEncoding.EncodeToString(hello)}
	if err := p.write(ctx, pakeFrame); err != nil {
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
			if werr := p.write(ctx, pakeFrame); werr != nil {
				return werr
			}
			continue
		case env.Relay != "":
			continue
		case env.Pake != "":
			if finished {
				continue // duplicate pake after a resend; already finished.
			}
			peerHelloBytes, derr := base64.StdEncoding.DecodeString(env.Pake)
			if derr != nil {
				return derr
			}
			var peerHello wire.PairHello
			if err := wire.StrictDecode(peerHelloBytes, &peerHello); err != nil {
				return err
			}
			if peerHello.Protocol != wire.Protocol {
				return fmt.Errorf("phone: unsupported pairing protocol %d", peerHello.Protocol)
			}
			p.agentPub, err = wire.ParseSigner(peerHello.Signer)
			if err != nil {
				return err
			}
			peer, derr := base64.StdEncoding.DecodeString(peerHello.Pake)
			if derr != nil {
				return derr
			}
			_, confirm, ferr := p.hs.FinishWithContext(peer, wire.PairBinding(p.room, peerHello.Signer, p.spki))
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

// readMessage opens a transport frame without confusing encrypted control
// messages with approval requests. Each caller verifies its signed message.
func (p *phoneStub) readMessage(ctx context.Context) ([]byte, wire.MessageKind, error) {
	for {
		env, err := p.read(ctx)
		if err != nil {
			return nil, "", err
		}
		if env.Box == "" {
			continue
		}
		plain, err := sealedbox.Open(p.key, env.Box)
		if err != nil {
			return nil, "", err
		}
		var header struct {
			Kind wire.MessageKind `json:"kind"`
		}
		if err := json.Unmarshal(plain, &header); err != nil {
			return nil, "", err
		}
		if header.Kind == wire.KindVAPIDKey {
			var vapid wire.VAPIDKey
			if err := wire.StrictDecode(plain, &vapid); err != nil {
				return nil, "", err
			}
			if vapid.Protocol != wire.Protocol || vapid.Room != p.room || !wire.Verify(p.agentPub, wire.VAPIDSigningMessage(vapid), vapid.Sig) {
				return nil, "", fmt.Errorf("phone: invalid signed VAPID update")
			}
			continue
		}
		return plain, header.Kind, nil
	}
}

func (p *phoneStub) readRequest(ctx context.Context) (wire.Request, error) {
	plain, kind, err := p.readMessage(ctx)
	if err != nil {
		return wire.Request{}, err
	}
	var req wire.Request
	if kind != wire.KindRequest {
		return req, fmt.Errorf("phone: expected request, got %q", kind)
	}
	if err := wire.StrictDecode(plain, &req); err != nil {
		return req, err
	}
	if err := wire.ValidateRequest(req); err != nil {
		return req, err
	}
	if req.Room != p.room || !wire.Verify(p.agentPub, wire.RequestSigningMessage(req), req.Sig) {
		return req, fmt.Errorf("phone: request was not signed by paired agent")
	}
	return req, nil
}

func (p *phoneStub) readAcceptedAck(ctx context.Context, dec wire.Decision) error {
	plain, kind, err := p.readMessage(ctx)
	if err != nil {
		return err
	}
	if kind != wire.KindAck {
		return fmt.Errorf("phone: expected acceptance receipt, got %q", kind)
	}
	var ack wire.Ack
	if err := wire.StrictDecode(plain, &ack); err != nil {
		return err
	}
	if ack.Protocol != wire.Protocol || ack.Room != p.room || ack.ID != dec.ID || ack.RequestHash != dec.RequestHash ||
		ack.DecisionHash != wire.DecisionHash(dec) || ack.Status != "accepted" || !wire.Verify(p.agentPub, wire.AckSigningMessage(ack), ack.Sig) {
		return fmt.Errorf("phone: invalid signed acceptance receipt")
	}
	return nil
}

func boundDecision(req wire.Request, result wire.Result) wire.Decision {
	return wire.Decision{Kind: wire.KindDecision, Protocol: wire.Protocol, Room: req.Room, ID: req.ID,
		RequestHash: wire.RequestHash(req), ResponseKind: req.Response.Kind, Result: result}
}

// answer verifies the actual request before signing an answer to its digest,
// then checks the agent's signed acceptance receipt.
func (p *phoneStub) answer(ctx context.Context) error {
	req, err := p.readRequest(ctx)
	if err != nil {
		return err
	}
	var result wire.Result
	switch req.Response.Kind {
	case wire.ResponseYesNo:
		yes := true
		result.Approved = &yes
	case wire.ResponseChoice:
		result.Choice = req.Response.Options[0]
	case wire.ResponseText:
		result.Text = "ok"
	}
	dec := boundDecision(req, result)
	dec.Sig, err = wire.Sign(p.signer, wire.BoundDecisionSigningMessage(dec))
	if err != nil {
		return err
	}
	out, err := wire.EncodeMessage(dec)
	if err != nil {
		return err
	}
	box, err := sealedbox.Seal(p.key, out)
	if err != nil {
		return err
	}
	if err := p.write(ctx, envelope{Box: box}); err != nil {
		return err
	}
	return p.readAcceptedAck(ctx, dec)
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

// TestIntegrationPushSubAbsorbedWithoutAsk is the end-to-end regression for the
// idle read-pump defect over the REAL relay: the phone seals + sends its Web
// Push subscription right after pairing and BEFORE any request. The agent's
// persistent reader must absorb it with no Ask in flight — otherwise a.sub stays
// nil and a backgrounded phone can never be woken ("paired but requests go
// nowhere"). Against the pre-fix code (reader ran only during an Ask) this fails.
func TestIntegrationPushSubAbsorbedWithoutAsk(t *testing.T) {
	relayURL := startRelay(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	ag, err := New(Config{RelayURL: relayURL})
	require.NoError(t, err)
	defer ag.Close()
	p, err := ag.NewPairing()
	require.NoError(t, err)

	phone, err := dialPhone(ctx, relayURL, p.RoomID, p.Canon)
	require.NoError(t, err)
	defer phone.conn.CloseNow()

	// Phone pairs, seals + sends its push subscription (like the real PWA), then
	// keeps reading so the socket stays alive — but NEVER answers a request.
	go func() {
		if e := phone.pair(ctx); e != nil {
			return
		}
		sub := wire.PushSub{Kind: wire.KindPushSub, Protocol: wire.Protocol, PushSeq: 1, Room: phone.room, Subscription: wire.PushSubscription{
			Endpoint: "https://web.push.apple.com/e2e-idle", Keys: wire.PushKeys{P256dh: testP256dh, Auth: testAuth},
		}}
		var e error
		sub.Sig, e = wire.Sign(phone.signer, wire.PushSigningMessage(sub))
		if e != nil {
			return
		}
		out, e := wire.EncodeMessage(sub)
		if e != nil {
			return
		}
		box, e := sealedbox.Seal(phone.key, out)
		if e != nil {
			return
		}
		if e := phone.write(ctx, envelope{Box: box}); e != nil {
			return
		}
		for { // drain the agent's vapid key etc.; keeps the socket serviced.
			if _, e := phone.read(ctx); e != nil {
				return
			}
		}
	}()

	require.NoError(t, ag.Pair(ctx, p))

	// With NO Ask in flight, the persistent reader must still absorb the sub.
	require.Eventually(t, func() bool {
		ag.mu.Lock()
		defer ag.mu.Unlock()
		return ag.sub != nil && ag.sub.Endpoint == "https://web.push.apple.com/e2e-idle"
	}, 6*time.Second, 25*time.Millisecond, "push sub must be absorbed with no Ask in flight")
}

// TestIntegrationIdleConnectionSurvivesPingCycle proves the persistent reader
// keeps a paired-but-idle connection alive past the relay keepalive: with NO Ask
// in flight for longer than the relay's ping interval (20s), a later request is
// still delivered on the SAME session. Before the read-pump the idle socket was
// reaped in ~20-40s and the agent stayed Paired() with a dead connection. Slow
// by nature (idles ~25s); skipped under -short. Point it at the deployed relay
// with AAH_RELAY_URL=wss://ask-a-human.ai/ws to check the production LB too.
func TestIntegrationIdleConnectionSurvivesPingCycle(t *testing.T) {
	if testing.Short() {
		t.Skip("idles past the relay ping cycle (~25s)")
	}
	relayURL := startRelay(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	ag, err := New(Config{RelayURL: relayURL})
	require.NoError(t, err)
	defer ag.Close()
	p, err := ag.NewPairing()
	require.NoError(t, err)

	phone, err := dialPhone(ctx, relayURL, p.RoomID, p.Canon)
	require.NoError(t, err)
	defer phone.conn.CloseNow()
	done := phone.runPhone(ctx) // pairs, then answers the (later) request

	require.NoError(t, ag.Pair(ctx, p))

	// Idle well past the relay ping interval with NO Ask. The persistent reader
	// on both ends must keep the sockets alive so the request below lands on the
	// same connection rather than a reaped-then-reconnected one.
	time.Sleep(25 * time.Second)

	dec, err := ag.Ask(ctx, wire.Request{ID: "r_idle", Title: "t", Summary: "s", Response: wire.Response{Kind: wire.ResponseYesNo}})
	require.NoError(t, err)
	require.NotNil(t, dec.Result.Approved)
	assert.True(t, *dec.Result.Approved)
	require.NoError(t, <-done)
}
