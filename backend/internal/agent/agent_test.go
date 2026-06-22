package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
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

// TestAskThrottlesReWake guards the push-storm fix: the relay re-reports the
// peer absent on every resend, but the human must get ONE wake-up, not a fresh
// push on every backoff tick. With reWakeInterval set huge, several
// undeliverable resends must yield at most the single proactive push (never a
// reactive re-wake per signal). Without the throttle this count climbs with the
// resend count.
func TestAskThrottlesReWake(t *testing.T) {
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()
	a := pairedAgent(t, key, conn, nil)

	var pushes atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		pushes.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	stubSub(t, a, srv.URL)
	a.reWakeInterval = time.Hour // far longer than the test: no reactive re-wake.

	// Three "peer absent" reports drive three resends; only then does the phone
	// answer. Each resend re-enters the reactive branch.
	pushSignal(t, conn, wire.SignalUndeliverable)
	pushSignal(t, conn, wire.SignalUndeliverable)
	pushSignal(t, conn, wire.SignalUndeliverable)
	approved := true
	go func() {
		time.Sleep(200 * time.Millisecond)
		pushBox(t, conn, key, wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: &approved}})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dec, err := a.Ask(ctx, yesnoReq())
	require.NoError(t, err)
	require.NotNil(t, dec.Result.Approved)
	assert.GreaterOrEqual(t, conn.writeCount(), 3, "the loop must have resent on each undeliverable")
	// Let the proactive goroutine's single push (if any) land before counting.
	time.Sleep(100 * time.Millisecond)
	assert.LessOrEqual(t, pushes.Load(), int32(1), "throttled: one wake-up, not one per resend")
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

// TestSendVAPIDKeyMatchesSigner asserts the public key the agent hands the
// phone during pairing is EXACTLY the key it signs wake-up pushes with: the
// vapid_key frame's public_key equals a.vapidPub, and Notify's VAPID
// Authorization header carries that same public key. This is the whole point of
// the design — signer == subscribe-key — so the push service never rejects.
func TestSendVAPIDKeyMatchesSigner(t *testing.T) {
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()
	a := pairedAgent(t, key, conn, nil)

	// 1) The sealed vapid_key frame carries a.vapidPub (only the PUBLIC key).
	require.NoError(t, a.sendVAPIDKey(context.Background(), a.sess))
	require.Equal(t, 1, conn.writeCount())

	var env envelope
	require.NoError(t, json.Unmarshal(conn.writes[0], &env))
	require.NotEmpty(t, env.Box)
	plain, err := sealedbox.Open(key, env.Box)
	require.NoError(t, err)
	var vk wire.VAPIDKey
	require.NoError(t, json.Unmarshal(plain, &vk))
	assert.Equal(t, wire.KindVAPIDKey, vk.Kind)
	assert.Equal(t, a.vapidPub, vk.PublicKey, "frame public_key must equal a.vapidPub")
	assert.NotContains(t, string(plain), a.vapidPriv, "private key must never cross the wire")

	// 2) Notify signs with that same public key: capture the VAPID Authorization
	// header at a stub push endpoint and assert it carries k=<a.vapidPub>. The
	// webpush lib emits "vapid t=<jwt>, k=<rawurl(pubkey)>", and our keys come
	// from GenerateVAPIDKeys (RawURLEncoding), so it equals a.vapidPub verbatim.
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	a.mu.Lock()
	a.sub = &webpush.Subscription{
		Endpoint: srv.URL,
		Keys:     webpush.Keys{P256dh: testP256dh, Auth: testAuth},
	}
	a.mu.Unlock()

	require.NoError(t, a.Notify(context.Background()))
	assert.Contains(t, gotAuth, "k="+a.vapidPub,
		"the push must be signed with the same public key handed to the phone")
}

// TestNotifyNoSubscription asserts Notify returns the benign errNoPushSub
// sentinel (which the Ask loop intentionally does NOT log) when no subscription
// has arrived yet.
func TestNotifyNoSubscription(t *testing.T) {
	a, err := New(Config{})
	require.NoError(t, err)
	err = a.Notify(context.Background())
	require.ErrorIs(t, err, errNoPushSub)
}

// TestVAPIDKeysPersistAcrossNew asserts the VAPID keypair is stable across two
// New() calls: with the env override unset and the user config dir pointed at a
// temp dir (via os.UserConfigDir's XDG_CONFIG_HOME), the second agent loads the
// pair the first one persisted instead of minting a fresh random one.
func TestVAPIDKeysPersistAcrossNew(t *testing.T) {
	dir := t.TempDir()
	// os.UserConfigDir honors XDG_CONFIG_HOME on linux and HOME elsewhere; set
	// both so the test is platform-independent. Clear the env override so the
	// persistence path is exercised.
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	t.Setenv("AAH_VAPID_PUBLIC_KEY", "")
	t.Setenv("AAH_VAPID_PRIVATE_KEY", "")

	a1, err := New(Config{})
	require.NoError(t, err)
	require.NotEmpty(t, a1.vapidPub)
	require.NotEmpty(t, a1.vapidPriv)

	a2, err := New(Config{})
	require.NoError(t, err)

	assert.Equal(t, a1.vapidPub, a2.vapidPub, "public key must be stable across restarts")
	assert.Equal(t, a1.vapidPriv, a2.vapidPriv, "private key must be stable across restarts")

	// And the on-disk file is the source of stability: removing it forces a new,
	// different keypair.
	path, err := vapidStatePath()
	require.NoError(t, err)
	require.NoError(t, os.Remove(path))
	a3, err := New(Config{})
	require.NoError(t, err)
	assert.NotEqual(t, a1.vapidPub, a3.vapidPub, "a fresh pair is minted once the state file is gone")
}

// testP256dh and testAuth are well-formed (base64url) client keys for a stub
// subscription: testP256dh is a real uncompressed P-256 point and testAuth is
// 16 random bytes, so webpush can build (encrypt) the push payload.
const (
	testP256dh = "BJINtcGg1K_0knrtHoburzRnrdJH1gpuACeg4JDROOhSJ7D6x4NS25OxQ6qwvRTe3A5S3lQ3WB00ZDdEPJp-PoY"
	testAuth   = "tu2pewRVkyFW06hUToHs8g"
)

// stubSub points an agent's subscription at srv so Notify performs a real signed
// POST against the test server (with well-formed client keys so encryption works).
func stubSub(t *testing.T, a *Agent, endpoint string) {
	t.Helper()
	a.mu.Lock()
	a.sub = &webpush.Subscription{Endpoint: endpoint, Keys: webpush.Keys{P256dh: testP256dh, Auth: testAuth}}
	a.mu.Unlock()
}

// vapidSubClaim decodes the "sub" claim from a webpush VAPID Authorization
// header ("vapid t=<jwt>, k=<pubkey>") so a test can assert the signed subject.
func vapidSubClaim(t *testing.T, authHeader string) string {
	t.Helper()
	const marker = "t="
	i := strings.Index(authHeader, marker)
	require.GreaterOrEqual(t, i, 0, "Authorization header must carry a VAPID token")
	tok := authHeader[i+len(marker):]
	if j := strings.IndexByte(tok, ','); j >= 0 {
		tok = tok[:j]
	}
	parts := strings.Split(strings.TrimSpace(tok), ".")
	require.Len(t, parts, 3, "VAPID token must be a JWT (header.payload.signature)")
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	require.NoError(t, err)
	var claims struct {
		Sub string `json:"sub"`
	}
	require.NoError(t, json.Unmarshal(payload, &claims))
	return claims.Sub
}

// TestResolveVAPIDSubject asserts the subject resolver: it defaults to the
// routable https project URL, passes a bare email or https override through, and
// strips a stray "mailto:" (webpush-go re-adds it, so keeping it would double).
func TestResolveVAPIDSubject(t *testing.T) {
	t.Setenv("AAH_VAPID_SUBJECT", "")
	assert.Equal(t, defaultVAPIDSubject, resolveVAPIDSubject())

	t.Setenv("AAH_VAPID_SUBJECT", "ops@example.com")
	assert.Equal(t, "ops@example.com", resolveVAPIDSubject(), "a bare email is passed through (webpush adds mailto: once)")

	t.Setenv("AAH_VAPID_SUBJECT", "mailto:ops@example.com")
	assert.Equal(t, "ops@example.com", resolveVAPIDSubject(), "a stray mailto: is stripped so webpush does not double-prefix")

	t.Setenv("AAH_VAPID_SUBJECT", "https://my.relay.example")
	assert.Equal(t, "https://my.relay.example", resolveVAPIDSubject(), "an https subject is passed through verbatim")

	t.Setenv("AAH_VAPID_SUBJECT", "  https://my.relay.example  ")
	assert.Equal(t, "https://my.relay.example", resolveVAPIDSubject(), "surrounding whitespace is trimmed")
}

// TestNotifyVAPIDSubjectRoutable asserts the SIGNED sub claim is the routable
// default — not a localhost mailto and never the doubled "mailto:mailto:" that
// webpush-go would produce from a mailto-prefixed input. A non-routable/malformed
// sub is what Apple's Web Push rejects with HTTP 403, killing every push.
func TestNotifyVAPIDSubjectRoutable(t *testing.T) {
	t.Setenv("AAH_VAPID_SUBJECT", "")
	conn := newFakeConn()
	a := pairedAgent(t, make([]byte, sealedbox.KeySize), conn, nil)

	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	stubSub(t, a, srv.URL)

	require.NoError(t, a.Notify(context.Background()))
	sub := vapidSubClaim(t, auth)
	assert.Equal(t, defaultVAPIDSubject, sub, "default subject must be the routable https project URL")
	assert.NotContains(t, sub, "localhost", "a localhost sub is rejected by Apple with 403")
	assert.NotContains(t, sub, "mailto:mailto:", "subject must never be double-prefixed")
}

// TestNotifyTTLAndUrgency asserts the wake-up carries a TTL long enough to
// survive a sleeping radio and high urgency so the push service delivers it.
func TestNotifyTTLAndUrgency(t *testing.T) {
	conn := newFakeConn()
	a := pairedAgent(t, make([]byte, sealedbox.KeySize), conn, nil)

	var ttl, urgency string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ttl = r.Header.Get("TTL")
		urgency = r.Header.Get("Urgency")
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	stubSub(t, a, srv.URL)

	require.NoError(t, a.Notify(context.Background()))
	assert.Equal(t, "300", ttl, "TTL must outlast the relay-detection window and a sleeping radio")
	assert.Equal(t, "high", urgency, "wake-ups are high urgency")
}

// TestNotifyDropsSubOnGone asserts a 410 Gone endpoint is dropped so the agent
// stops signing pushes to a dead endpoint and reports errNoPushSub thereafter.
func TestNotifyDropsSubOnGone(t *testing.T) {
	a, err := New(Config{})
	require.NoError(t, err)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusGone)
	}))
	defer srv.Close()
	stubSub(t, a, srv.URL)

	require.Error(t, a.Notify(context.Background()))
	a.mu.Lock()
	sub := a.sub
	a.mu.Unlock()
	assert.Nil(t, sub, "a 410 Gone endpoint must be dropped")
	require.ErrorIs(t, a.Notify(context.Background()), errNoPushSub, "after drop, Notify reports no subscription")
}

// TestAskFiresProactivePush asserts a fresh request proactively wakes the phone
// with EXACTLY ONE push, without the relay ever signaling the peer absent. This
// is the core fix: a backgrounded phone (whose frozen socket the relay still
// believes present) is nudged at request time instead of ~20-40s later, if ever.
func TestAskFiresProactivePush(t *testing.T) {
	t.Setenv("AAH_VAPID_SUBJECT", "")
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()

	var pushes atomic.Int32
	pushed := make(chan struct{}, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		pushes.Add(1)
		w.WriteHeader(http.StatusCreated)
		select {
		case pushed <- struct{}{}:
		default:
		}
	}))
	defer srv.Close()

	a := pairedAgent(t, key, conn, nil)
	stubSub(t, a, srv.URL)

	approved := true
	go func() {
		<-pushed // answer only AFTER the proactive push has fired
		pushBox(t, conn, key, wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: &approved}})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	dec, err := a.Ask(ctx, yesnoReq())
	require.NoError(t, err)
	require.NotNil(t, dec.Result.Approved)
	// No undeliverable/peer_left was ever sent, yet a push fired — proactive, not
	// relay-gated — and exactly once.
	assert.Equal(t, int32(1), pushes.Load())
	assert.Equal(t, 1, conn.writeCount(), "request delivered live; one box written")
}

// TestAskProactivePushFiresOnceAcrossReconnect asserts the proactive wake-up is
// single-fire per Ask even when the request is re-announced over a fresh socket:
// re-pushing on every cycle risks iOS revoking the subscription.
func TestAskProactivePushFiresOnceAcrossReconnect(t *testing.T) {
	t.Setenv("AAH_VAPID_SUBJECT", "")
	key := make([]byte, sealedbox.KeySize)
	first := newFakeConn()
	second := newFakeConn()

	var pushes atomic.Int32
	pushed := make(chan struct{}, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		pushes.Add(1)
		w.WriteHeader(http.StatusCreated)
		select {
		case pushed <- struct{}{}:
		default:
		}
	}))
	defer srv.Close()

	dial := func(_ context.Context, _, _ string) (frameConn, error) { return second, nil }
	a := pairedAgent(t, key, first, dial)
	stubSub(t, a, srv.URL)

	approved := true
	go func() {
		<-pushed          // proactive push fired after the first write on `first`
		_ = first.close() // kill the live conn -> errReconnect -> re-dial `second`
		for second.writeCount() < 1 {
			time.Sleep(2 * time.Millisecond) // wait for the re-announce on `second`
		}
		pushBox(t, second, key, wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: &approved}})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := a.Ask(ctx, yesnoReq())
	require.NoError(t, err)
	assert.Equal(t, int32(1), pushes.Load(), "proactive wake-up is single-fire per Ask")
}

// TestAskReactiveWakeSendsPush asserts the REACTIVE (peer-absent) branch still
// sends a real wake-up push once its throttle window elapses: a request whose
// first delivery is undeliverable produces the proactive push AND a reactive
// re-wake (>=2 pushes), so a regression that dropped the reactive a.wakePush
// would be caught here (the peer-absent tests use no subscription, so they
// never exercise this path). reWakeInterval is set to 0 so the reactive re-wake
// is due immediately — TestAskThrottlesReWake covers the throttle itself.
func TestAskReactiveWakeSendsPush(t *testing.T) {
	t.Setenv("AAH_VAPID_SUBJECT", "")
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()

	var pushes atomic.Int32
	pushed := make(chan struct{}, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		pushes.Add(1)
		w.WriteHeader(http.StatusCreated)
		select {
		case pushed <- struct{}{}:
		default:
		}
	}))
	defer srv.Close()

	a := pairedAgent(t, key, conn, nil)
	stubSub(t, a, srv.URL)
	a.reWakeInterval = 0 // reactive re-wake due on the first peer-absent report.

	// First delivery finds the peer absent -> reactive re-wake; then answer once
	// BOTH the proactive and reactive pushes have fired (deterministic, no sleep).
	pushSignal(t, conn, wire.SignalUndeliverable)
	approved := true
	go func() {
		<-pushed // proactive (after the first write)
		<-pushed // reactive (after undeliverable)
		pushBox(t, conn, key, wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: &approved}})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dec, err := a.Ask(ctx, yesnoReq())
	require.NoError(t, err)
	require.NotNil(t, dec.Result.Approved)
	assert.GreaterOrEqual(t, pushes.Load(), int32(2), "proactive + reactive wake-ups both send a push")
}
