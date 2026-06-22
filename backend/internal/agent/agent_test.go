package agent

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/askahuman/askahuman/backend/pkg/paircode"
	"github.com/askahuman/askahuman/backend/pkg/sealedbox"
	"github.com/askahuman/askahuman/backend/pkg/wire"
)

// fakeConn is a scriptable frameConn. inbound is the queue of frames the
// agent will read; writes are captured; readErr/writeErr inject transport
// failures. It is safe for the single-goroutine agent loop plus a test
// driver pushing inbound frames.
type fakeConn struct {
	mu      sync.Mutex
	inbound chan []byte
	writes  [][]byte
	closed  bool
}

func newFakeConn() *fakeConn {
	return &fakeConn{inbound: make(chan []byte, 16)}
}

func (f *fakeConn) readFrame(ctx context.Context) ([]byte, error) {
	select {
	case b, ok := <-f.inbound:
		if !ok {
			return nil, errors.New("fake: conn closed")
		}
		return b, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (f *fakeConn) writeFrame(_ context.Context, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return errors.New("fake: write to closed conn")
	}
	cp := make([]byte, len(data))
	copy(cp, data)
	f.writes = append(f.writes, cp)
	return nil
}

func (f *fakeConn) close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		close(f.inbound)
	}
	return nil
}

func (f *fakeConn) writeCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.writes)
}

// pushBox seals dec under key and queues it as a box frame.
func pushBox(t *testing.T, f *fakeConn, key []byte, v any) {
	t.Helper()
	plain, err := json.Marshal(v)
	require.NoError(t, err)
	box, err := sealedbox.Seal(key, plain)
	require.NoError(t, err)
	env, err := json.Marshal(envelope{Box: box})
	require.NoError(t, err)
	f.inbound <- env
}

func pushSignal(t *testing.T, f *fakeConn, sig wire.RelaySignal) {
	t.Helper()
	env, err := json.Marshal(envelope{Relay: sig})
	require.NoError(t, err)
	f.inbound <- env
}

// pairedAgent returns an Agent with a session pre-wired to conn under key,
// bypassing the SPAKE2 handshake (exercised separately).
func pairedAgent(t *testing.T, key []byte, conn frameConn, dial dialer) *Agent {
	t.Helper()
	a, err := New(Config{RelayURL: "ws://test/ws"})
	require.NoError(t, err)
	a.dial = dial
	a.sess = &Session{relayURL: "ws://test/ws", roomID: "room1", code: "C0-DE5", key: key, conn: conn, dial: dial}
	// Short backoff via context-bound waits; tests use small sleeps.
	return a
}

func yesnoReq() wire.Request {
	return wire.Request{ID: "req_1", Title: "t", Summary: "s", Response: wire.Response{Kind: wire.ResponseYesNo}}
}

func TestAskReturnsDecision(t *testing.T) {
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()
	a := pairedAgent(t, key, conn, nil)

	approved := true
	pushBox(t, conn, key, wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: &approved}})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	dec, err := a.Ask(ctx, yesnoReq())
	require.NoError(t, err)
	require.NotNil(t, dec.Result.Approved)
	assert.True(t, *dec.Result.Approved)
	assert.Equal(t, 1, conn.writeCount()) // one box sent.
}

func TestAskIgnoresWrongID(t *testing.T) {
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()
	a := pairedAgent(t, key, conn, nil)

	// A decision for a different id (dup/stale) must be ignored.
	other := false
	pushBox(t, conn, key, wire.Decision{Kind: wire.KindDecision, ID: "req_OTHER", Result: wire.Result{Approved: &other}})
	approved := true
	pushBox(t, conn, key, wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: &approved}})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	dec, err := a.Ask(ctx, yesnoReq())
	require.NoError(t, err)
	require.NotNil(t, dec.Result.Approved)
	assert.True(t, *dec.Result.Approved)
}

func TestAskIgnoresUnauthenticatedFrame(t *testing.T) {
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()
	a := pairedAgent(t, key, conn, nil)

	// A box that does not open under the session key must never be trusted.
	wrongKey := make([]byte, sealedbox.KeySize)
	wrongKey[0] = 0xff
	approved := true
	pushBox(t, conn, wrongKey, wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: &approved}})
	// Then the real one.
	pushBox(t, conn, key, wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: &approved}})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	dec, err := a.Ask(ctx, yesnoReq())
	require.NoError(t, err)
	require.NotNil(t, dec.Result.Approved)
}

func TestAskResendsOnUndeliverable(t *testing.T) {
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()
	a := pairedAgent(t, key, conn, nil)

	// First attempt: peer absent. Then the phone answers.
	pushSignal(t, conn, wire.SignalUndeliverable)
	approved := true
	go func() {
		time.Sleep(50 * time.Millisecond)
		pushBox(t, conn, key, wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: &approved}})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	dec, err := a.Ask(ctx, yesnoReq())
	require.NoError(t, err)
	require.NotNil(t, dec.Result.Approved)
	assert.GreaterOrEqual(t, conn.writeCount(), 2) // resent at least once.
}

func TestAskReconnectsOnTransportError(t *testing.T) {
	key := make([]byte, sealedbox.KeySize)
	first := newFakeConn()
	second := newFakeConn()

	var dialCalls int32
	var dialMu sync.Mutex
	dial := func(_ context.Context, _, _ string) (frameConn, error) {
		dialMu.Lock()
		defer dialMu.Unlock()
		dialCalls++
		return second, nil
	}

	a := pairedAgent(t, key, first, dial)

	// Kill the first connection: the agent's read returns an error -> reconnect.
	approved := true
	go func() {
		time.Sleep(30 * time.Millisecond)
		_ = first.close() // read error -> errReconnect.
		time.Sleep(30 * time.Millisecond)
		pushBox(t, second, key, wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: &approved}})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	dec, err := a.Ask(ctx, yesnoReq())
	require.NoError(t, err)
	require.NotNil(t, dec.Result.Approved)
	dialMu.Lock()
	assert.GreaterOrEqual(t, dialCalls, int32(1))
	dialMu.Unlock()
}

func TestAskTimeoutNeverApproves(t *testing.T) {
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()
	a := pairedAgent(t, key, conn, nil)

	// Never answer; the phone is absent forever.
	pushSignal(t, conn, wire.SignalUndeliverable)

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	dec, err := a.Ask(ctx, yesnoReq())
	require.ErrorIs(t, err, ErrTimeout)
	assert.Nil(t, dec.Result.Approved) // a timeout is never an approval.
}

func TestAskNotPaired(t *testing.T) {
	a, err := New(Config{})
	require.NoError(t, err)
	_, err = a.Ask(context.Background(), yesnoReq())
	require.ErrorIs(t, err, ErrNotPaired)
}

func TestAbsorbPushSubscription(t *testing.T) {
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()
	a := pairedAgent(t, key, conn, nil)

	// A push_sub arrives before the decision; it must be absorbed and stored.
	pushBox(t, conn, key, wire.PushSub{
		Kind:         wire.KindPushSub,
		Subscription: wire.PushSubscription{Endpoint: "https://push.example/abc", Keys: wire.PushKeys{P256dh: "p", Auth: "x"}},
	})
	approved := true
	pushBox(t, conn, key, wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: &approved}})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := a.Ask(ctx, yesnoReq())
	require.NoError(t, err)

	a.mu.Lock()
	sub := a.sub
	a.mu.Unlock()
	require.NotNil(t, sub)
	assert.Equal(t, "https://push.example/abc", sub.Endpoint)
}

func TestAskExpiresInSNeverApproves(t *testing.T) {
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()
	a := pairedAgent(t, key, conn, nil)

	// Phone is absent forever; the request's own ExpiresInS must fire ErrTimeout
	// even though the external ctx has a long deadline.
	pushSignal(t, conn, wire.SignalUndeliverable)

	req := yesnoReq()
	req.ExpiresInS = 1 // shortest unit the field allows.

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dec, err := a.Ask(ctx, req)
	require.ErrorIs(t, err, ErrTimeout)
	assert.Nil(t, dec.Result.Approved) // a timeout is never an approval.
}

func TestAskSingleFlightRejectsConcurrent(t *testing.T) {
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()
	a := pairedAgent(t, key, conn, nil)

	// First Ask blocks (phone absent). A concurrent Ask must get ErrBusy.
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		close(started)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		approved := true
		go func() {
			time.Sleep(100 * time.Millisecond)
			pushBox(t, conn, key, wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: &approved}})
		}()
		_, err := a.Ask(ctx, yesnoReq())
		done <- err
	}()

	<-started
	// Spin until the first Ask has grabbed the single-flight guard.
	require.Eventually(t, func() bool { return a.asking.Load() }, time.Second, time.Millisecond)

	_, err := a.Ask(context.Background(), yesnoReq())
	require.ErrorIs(t, err, ErrBusy)

	require.NoError(t, <-done)
}

func TestAskResendsOnPeerLeft(t *testing.T) {
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()
	a := pairedAgent(t, key, conn, nil)

	// Phone leaves mid-request, then returns and answers.
	pushSignal(t, conn, wire.SignalPeerLeft)
	approved := true
	go func() {
		time.Sleep(50 * time.Millisecond)
		pushBox(t, conn, key, wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: &approved}})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	dec, err := a.Ask(ctx, yesnoReq())
	require.NoError(t, err)
	require.NotNil(t, dec.Result.Approved)
	assert.GreaterOrEqual(t, conn.writeCount(), 2) // re-announced after peer_left.
}

func TestAskRejectsKindMismatch(t *testing.T) {
	tests := []struct {
		name string
		req  wire.Request
		bad  wire.Decision
		good wire.Decision
	}{
		{
			name: "yesno missing approve",
			req:  wire.Request{ID: "req_1", Response: wire.Response{Kind: wire.ResponseYesNo}},
			bad:  wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Text: "yes"}},
			good: wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: boolPtr(true)}},
		},
		{
			name: "choice not in options",
			req:  wire.Request{ID: "req_1", Response: wire.Response{Kind: wire.ResponseChoice, Options: []string{"a", "b"}}},
			bad:  wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Choice: "z"}},
			good: wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Choice: "b"}},
		},
		{
			name: "text over max_len",
			req:  wire.Request{ID: "req_1", Response: wire.Response{Kind: wire.ResponseText, MaxLen: 3}},
			bad:  wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Text: "toolong"}},
			good: wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Text: "ok"}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			key := make([]byte, sealedbox.KeySize)
			conn := newFakeConn()
			a := pairedAgent(t, key, conn, nil)

			// The mismatched decision must be ignored; only the well-formed one returns.
			pushBox(t, conn, key, tt.bad)
			pushBox(t, conn, key, tt.good)

			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			dec, err := a.Ask(ctx, tt.req)
			require.NoError(t, err)
			assert.True(t, resultMatchesKind(dec.Result, tt.req.Response))
		})
	}
}

func boolPtr(b bool) *bool { return &b }

func TestNewPairingDerivesRoomFromCode(t *testing.T) {
	a, err := New(Config{RelayURL: "ws://host:8080/ws"})
	require.NoError(t, err)
	p, err := a.NewPairing()
	require.NoError(t, err)

	// Room is a deterministic, one-way function of the canonical code — nothing
	// is carried in a URL.
	assert.Len(t, p.RoomID, 16)
	assert.Contains(t, p.Display, "-", "display form is grouped XXXX-XXXX")

	canon, err := paircode.Canonicalize(p.Display)
	require.NoError(t, err)
	assert.Equal(t, canon, p.Canon, "Canon must be the canonicalized display code")

	wantRoom, err := paircode.RoomFromCode(p.Canon)
	require.NoError(t, err)
	assert.Equal(t, wantRoom, p.RoomID, "RoomID must equal RoomFromCode(Canon)")
}
