package agent

import (
	"context"
	"crypto/elliptic"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"

	"github.com/askahuman/askahuman/backend/pkg/sealedbox"
	"github.com/askahuman/askahuman/backend/pkg/wire"
)

func replayAgent(t *testing.T, conn *fakeConn) *Agent {
	t.Helper()
	priv, pub, err := webpush.GenerateVAPIDKeys()
	require.NoError(t, err)
	t.Setenv("AAH_VAPID_PRIVATE_KEY", priv)
	t.Setenv("AAH_VAPID_PUBLIC_KEY", pub)
	return pairedAgent(t, make([]byte, sealedbox.KeySize), conn, nil)
}

func replayPush(t *testing.T, phone deviceSigner, room string, seq int64, endpoint string) wire.PushSub {
	t.Helper()
	ps := wire.PushSub{
		Kind: wire.KindPushSub, Protocol: wire.Protocol, Room: room, PushSeq: seq,
		Subscription: wire.PushSubscription{Endpoint: endpoint, Keys: wire.PushKeys{P256dh: testP256dh, Auth: testAuth}},
	}
	var err error
	ps.Sig, err = wire.Sign(phone.priv, wire.PushSigningMessage(ps))
	require.NoError(t, err)
	return ps
}

func replayJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	require.NoError(t, err)
	return raw
}

func replaySubscription(t *testing.T, a *Agent, endpoint string, seq int64) {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	require.NotNil(t, a.sub)
	require.Equal(t, endpoint, a.sub.Endpoint)
	require.Equal(t, seq, a.sess.pushSeq)
}

func TestProtocolReplayPushOldNewOld(t *testing.T) {
	a := replayAgent(t, newFakeConn())
	phone := testPhone(t, a)
	old := replayPush(t, phone, testRoom, 1, "https://web.push.apple.com/old")
	newer := replayPush(t, phone, testRoom, 2, "https://web.push.apple.com/new")
	require.True(t, a.absorbPush(replayJSON(t, old)))
	replaySubscription(t, a, old.Subscription.Endpoint, 1)
	for _, ps := range []wire.PushSub{newer, old, newer} {
		require.True(t, a.absorbPush(replayJSON(t, ps)))
		replaySubscription(t, a, newer.Subscription.Endpoint, 2)
	}

	// Even a correctly signed different endpoint cannot reuse an accepted seq.
	sameSeq := replayPush(t, phone, testRoom, 2, "https://web.push.apple.com/conflict")
	require.True(t, a.absorbPush(replayJSON(t, sameSeq)))
	replaySubscription(t, a, newer.Subscription.Endpoint, 2)

	// The sequence is itself signed: a relay cannot increase an old frame's seq.
	old.PushSeq = 100
	require.True(t, a.absorbPush(replayJSON(t, old)))
	replaySubscription(t, a, newer.Subscription.Endpoint, 2)
}

// Go's verifier consults Curve.Params before verifying the actual P-256
// signature. Pause one verification there, without changing its math or adding
// a production hook; other concurrent verifications continue normally.
type replayVerifyGate struct {
	elliptic.Curve
	entered chan struct{}
	release chan struct{}
	first   atomic.Bool
}

func (g *replayVerifyGate) Params() *elliptic.CurveParams {
	if g.first.CompareAndSwap(false, true) {
		close(g.entered)
		<-g.release
	}
	return g.Curve.Params()
}

func replayBlockVerification(t *testing.T, sess *Session) (*replayVerifyGate, func()) {
	t.Helper()
	gate := &replayVerifyGate{Curve: sess.devicePub.Curve, entered: make(chan struct{}), release: make(chan struct{})}
	pub := *sess.devicePub // Do not modify the fixture phone's private key.
	pub.Curve = gate
	sess.devicePub = &pub
	var once sync.Once
	release := func() { once.Do(func() { close(gate.release) }) }
	t.Cleanup(release)
	return gate, release
}

func replayWait(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the deterministic replay fixture")
	}
}

func TestProtocolReplayPushConcurrentOlderVerificationFinishesLast(t *testing.T) {
	a := replayAgent(t, newFakeConn())
	phone := testPhone(t, a)
	old := replayJSON(t, replayPush(t, phone, testRoom, 1, "https://web.push.apple.com/slow-old"))
	newer := replayPush(t, phone, testRoom, 2, "https://web.push.apple.com/fast-new")
	gate, release := replayBlockVerification(t, a.sess)
	done := make(chan struct{})
	go func() { a.absorbPush(old); close(done) }()
	replayWait(t, gate.entered)
	require.True(t, a.absorbPush(replayJSON(t, newer)))
	replaySubscription(t, a, newer.Subscription.Endpoint, 2)
	release()
	replayWait(t, done)
	replaySubscription(t, a, newer.Subscription.Endpoint, 2)
}

func TestProtocolReplayPushCannotCommitAfterSessionReplacement(t *testing.T) {
	a := replayAgent(t, newFakeConn())
	oldSession := a.sess
	old := replayJSON(t, replayPush(t, testPhone(t, a), testRoom, 900, "https://web.push.apple.com/stale-session"))
	gate, release := replayBlockVerification(t, oldSession)
	done := make(chan struct{})
	go func() { a.absorbPush(old); close(done) }()
	replayWait(t, gate.entered)

	// Match a pairing reset: new session object and identity, even if a room ID
	// happens to repeat. An old in-flight verification must not authorize it.
	phone := newDeviceSigner(t)
	replacement := &Session{protocol: wire.Protocol, roomID: testRoom, devicePub: &phone.priv.PublicKey, conn: newFakeConn()}
	a.mu.Lock()
	a.sess, a.sub = replacement, nil
	a.mu.Unlock()
	t.Cleanup(func() { _ = oldSession.currentConn().close() })
	current := replayPush(t, phone, testRoom, 1, "https://web.push.apple.com/current-session")
	require.True(t, a.absorbPush(replayJSON(t, current)))
	release()
	replayWait(t, done)
	replaySubscription(t, a, current.Subscription.Endpoint, 1)
	require.Zero(t, oldSession.pushSeq, "the stale session must not commit either")
	// Also reject a fully completed old signature received after replacement.
	require.True(t, a.absorbPush(old))
	replaySubscription(t, a, current.Subscription.Endpoint, 1)
}

func TestProtocolReplayInvalidPushSequencesDoNotReplaceOrBurnCounter(t *testing.T) {
	a := replayAgent(t, newFakeConn())
	phone := testPhone(t, a)
	working := replayPush(t, phone, testRoom, 2, "https://web.push.apple.com/working")
	require.True(t, a.absorbPush(replayJSON(t, working)))
	for _, seq := range []string{"0", "-1", "2.5", "3e0", "9007199254740992", `"3"`, "null", ""} {
		t.Run("sequence_"+seq, func(t *testing.T) {
			// Zero has a valid signature, proving rejection is not incidental to
			// a bad signature. The others probe the raw JSON parsing boundary.
			invalid := replayPush(t, phone, testRoom, 0, "https://web.push.apple.com/invalid")
			var fields map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(replayJSON(t, invalid), &fields))
			if seq == "" {
				delete(fields, "push_seq")
			} else {
				fields["push_seq"] = json.RawMessage(seq)
			}
			a.absorbPush(replayJSON(t, fields))
			replaySubscription(t, a, working.Subscription.Endpoint, 2)
		})
	}
	// Admission must finish before advancing the counter; rejected high seqs
	// must not prevent a later, lower legitimate update from reaching the agent.
	unsafeEndpoint := replayPush(t, phone, testRoom, 100, "https://127.0.0.1/private")
	require.True(t, a.absorbPush(replayJSON(t, unsafeEndpoint)))
	wrongSigner := replayPush(t, newDeviceSigner(t), testRoom, 200, "https://web.push.apple.com/forged")
	require.True(t, a.absorbPush(replayJSON(t, wrongSigner)))
	wrongRoom := replayPush(t, phone, "fedcba9876543210", 300, "https://web.push.apple.com/wrong-room")
	require.True(t, a.absorbPush(replayJSON(t, wrongRoom)))
	replaySubscription(t, a, working.Subscription.Endpoint, 2)
	next := replayPush(t, phone, testRoom, 3, "https://web.push.apple.com/next")
	require.True(t, a.absorbPush(replayJSON(t, next)))
	replaySubscription(t, a, next.Subscription.Endpoint, 3)
	ceiling := replayPush(t, phone, testRoom, wire.MaxSafeInteger, "https://web.push.apple.com/ceiling")
	require.True(t, a.absorbPush(replayJSON(t, ceiling)))
	replaySubscription(t, a, ceiling.Subscription.Endpoint, wire.MaxSafeInteger)
}

func replayRequests(t *testing.T, conn *fakeConn, key []byte) []wire.Request {
	t.Helper()
	conn.mu.Lock()
	frames := append([][]byte(nil), conn.writes...)
	conn.mu.Unlock()
	var requests []wire.Request
	for _, frame := range frames {
		var env envelope
		if json.Unmarshal(frame, &env) != nil || env.Box == "" {
			continue
		}
		plain, err := sealedbox.Open(key, env.Box)
		require.NoError(t, err)
		var req wire.Request
		if wire.StrictDecode(plain, &req) == nil && req.Kind == wire.KindRequest {
			requests = append(requests, req)
		}
	}
	return requests
}

func replayAnswer(t *testing.T, a *Agent, conn *fakeConn, req wire.Request, result wire.Result) wire.Decision {
	t.Helper()
	require.NoError(t, wire.ValidateRequest(req))
	require.True(t, wire.Verify(&a.sess.agentSigner.PublicKey, wire.RequestSigningMessage(req), req.Sig))
	d := signFor(t, testPhone(t, a), req, result)
	var fields map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(replayJSON(t, d), &fields))
	if req.Response.Kind == wire.ResponseText {
		// Explicit presence is significant on the phone wire, including "".
		fields["result"] = replayJSON(t, map[string]string{"text": result.Text})
	}
	pushBox(t, conn, a.sess.key, fields)
	return d
}

func TestProtocolReplayRequestSequenceIsStableAcrossReannounce(t *testing.T) {
	conn := newFakeConn()
	a := replayAgent(t, conn)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for seq := int64(1); seq <= 2; seq++ {
		prior := len(replayRequests(t, conn, a.sess.key))
		input := yesnoReq()
		input.ID = fmt.Sprintf("sequence-%d", seq)
		input.RequestSeq = 999 // Agent assigns the sequence, not its caller.
		done := make(chan error, 1)
		go func() { _, err := a.Ask(ctx, input); done <- err }()
		require.Eventually(t, func() bool { return len(replayRequests(t, conn, a.sess.key)) > prior }, 2*time.Second, time.Millisecond)
		first := replayRequests(t, conn, a.sess.key)[prior]
		require.Equal(t, seq, first.RequestSeq)
		if seq == 1 {
			pushSignal(t, conn, wire.SignalUndeliverable)
			require.Eventually(t, func() bool { return len(replayRequests(t, conn, a.sess.key)) > prior+1 }, 2*time.Second, time.Millisecond)
			repeated := replayRequests(t, conn, a.sess.key)[prior+1]
			require.Equal(t, first, repeated, "re-announcement must retain sequence, signature, and original deadline")
		}
		replayAnswer(t, a, conn, first, wire.Result{Approved: boolPtr(false)})
		require.NoError(t, <-done)
	}
	require.Equal(t, int64(2), a.sess.requestSeq.Load())
}

func TestProtocolReplayRequestSequenceRangeAndExhaustion(t *testing.T) {
	a := replayAgent(t, newFakeConn())
	valid, err := prepareRequest(context.Background(), yesnoReq(), a.sess)
	require.NoError(t, err)
	for _, seq := range []string{"0", "-1", "1.5", "1e0", "9007199254740992", ""} {
		t.Run("sequence_"+seq, func(t *testing.T) {
			var fields map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(replayJSON(t, valid), &fields))
			if seq == "" {
				delete(fields, "request_seq")
			} else {
				fields["request_seq"] = json.RawMessage(seq)
			}
			var decoded wire.Request
			err := wire.StrictDecode(replayJSON(t, fields), &decoded)
			if err == nil {
				err = wire.ValidateRequest(decoded)
			}
			require.Error(t, err)
		})
	}
	a.sess.requestSeq.Store(wire.MaxSafeInteger - 1)
	last, err := prepareRequest(context.Background(), yesnoReq(), a.sess)
	require.NoError(t, err)
	require.Equal(t, wire.MaxSafeInteger, last.RequestSeq)
	require.True(t, wire.Verify(&a.sess.agentSigner.PublicKey, wire.RequestSigningMessage(last), last.Sig))
	overflow, err := prepareRequest(context.Background(), yesnoReq(), a.sess)
	require.ErrorContains(t, err, "sequence exhausted")
	require.Empty(t, overflow.Sig, "an unsafe sequence is never signed")
}

func TestProtocolReplayMCPEmptyTextAndExclusiveResultFields(t *testing.T) {
	for _, tc := range []struct {
		name   string
		kind   wire.ResponseKind
		result wire.Result
		want   map[string]any
	}{
		{"empty_text", wire.ResponseText, wire.Result{Text: ""}, map[string]any{"text": ""}},
		{"decline", wire.ResponseYesNo, wire.Result{Approved: boolPtr(false)}, map[string]any{"approved": false}},
		{"choice", wire.ResponseChoice, wire.Result{Choice: "Keep"}, map[string]any{"choice": "Keep"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn := newFakeConn()
			a := replayAgent(t, conn)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			h := NewMCPServer(a, io.Discard)
			st, ct := mcp.NewInMemoryTransports()
			server, err := h.Server().Connect(ctx, st, nil)
			require.NoError(t, err)
			defer server.Close()
			client, err := mcp.NewClient(&mcp.Implementation{Name: "replay-result-test", Version: "test"}, nil).Connect(ctx, ct, nil)
			require.NoError(t, err)
			defer client.Close()
			args := map[string]any{"title": "Harmless result test", "summary": "Check the exact reply field.", "response_kind": string(tc.kind)}
			if tc.kind == wire.ResponseChoice {
				args["options"] = []string{"Keep", "Stop"}
			}
			type outcome struct {
				result *mcp.CallToolResult
				err    error
			}
			done := make(chan outcome, 1)
			go func() {
				result, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "request_approval", Arguments: args})
				done <- outcome{result, err}
			}()
			require.Eventually(t, func() bool { return len(replayRequests(t, conn, a.sess.key)) == 1 }, 2*time.Second, time.Millisecond)
			req := replayRequests(t, conn, a.sess.key)[0]
			decision := replayAnswer(t, a, conn, req, tc.result)
			out := <-done
			require.NoError(t, out.err)
			require.False(t, out.result.IsError, "%+v", out.result.Content)
			require.Equal(t, tc.want, out.result.StructuredContent)
			require.Len(t, out.result.Content, 1)
			text, ok := out.result.Content[0].(*mcp.TextContent)
			require.True(t, ok)
			var content map[string]any
			require.NoError(t, json.Unmarshal([]byte(text.Text), &content))
			require.Equal(t, tc.want, content)
			// The output follows the real signed acceptance point, not merely an
			// output-struct marshal that could mask a rejected empty decision.
			a.waiterMu.Lock()
			ack, found := a.sess.receipts[wire.RequestHash(req)]
			a.waiterMu.Unlock()
			require.True(t, found)
			require.Equal(t, "accepted", ack.Status)
			require.Equal(t, wire.DecisionHash(decision), ack.DecisionHash)
			require.True(t, wire.Verify(&a.sess.agentSigner.PublicKey, wire.AckSigningMessage(ack), ack.Sig))
		})
	}
}
