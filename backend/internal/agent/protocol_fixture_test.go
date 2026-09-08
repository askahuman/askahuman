package agent

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/askahuman/askahuman/backend/pkg/sealedbox"
	"github.com/askahuman/askahuman/backend/pkg/wire"
)

const testRoom = "0123456789abcdef"

var testPushSequence atomic.Int64

var testPhones sync.Map // *Agent -> deviceSigner, test-private signing keys only.

func testPhone(t *testing.T, a *Agent) deviceSigner {
	t.Helper()
	p, ok := testPhones.Load(a)
	require.True(t, ok)
	return p.(deviceSigner)
}

// answerBox migrates the old pre-queued answer fixtures to the v2 exchange:
// actually read and verify the agent's signed question before signing an answer.
// pushBox remains the raw adversarial-frame injector; it never repairs a frame.
func answerBox(t *testing.T, a *Agent, f *fakeConn, key []byte, v any) {
	t.Helper()
	switch d := v.(type) {
	case wire.Decision:
		answerWith(t, a, f, key, d, testPhone(t, a), nil)
	case wire.PushSub:
		d.Protocol = wire.Protocol
		d.Room = a.sess.roomID
		d.PushSeq = testPushSequence.Add(1)
		var err error
		d.Sig, err = wire.Sign(testPhone(t, a).priv, wire.PushSigningMessage(d))
		require.NoError(t, err)
		pushBox(t, f, key, d)
	default:
		pushBox(t, f, key, v)
	}
}

func answerWith(t *testing.T, a *Agent, f *fakeConn, key []byte, d wire.Decision, signer deviceSigner, mutate func(*wire.Decision)) {
	t.Helper()
	go func() {
		var req wire.Request
		deadline := time.Now().Add(4 * time.Second)
		for time.Now().Before(deadline) {
			f.mu.Lock()
			frames := append([][]byte(nil), f.writes...)
			closed := f.closed
			f.mu.Unlock()
			if closed {
				return
			}
			for i := len(frames) - 1; i >= 0; i-- {
				var env envelope
				if json.Unmarshal(frames[i], &env) != nil || env.Box == "" {
					continue
				}
				plain, err := sealedbox.Open(a.sess.key, env.Box)
				if err != nil {
					continue
				}
				var r wire.Request
				if wire.StrictDecode(plain, &r) != nil || r.Kind != wire.KindRequest {
					continue
				}
				if r.ID != d.ID && d.ID != "req_OTHER" {
					continue
				}
				if !wire.Verify(&a.sess.agentSigner.PublicKey, wire.RequestSigningMessage(r), r.Sig) {
					t.Error("fake phone received unverifiable request")
					return
				}
				req = r
				break
			}
			if req.ID != "" {
				break
			}
			time.Sleep(time.Millisecond)
		}
		if req.ID == "" {
			t.Error("fake phone did not receive the signed question")
			return
		}
		d.Protocol = wire.Protocol
		d.Room = req.Room
		d.RequestHash = wire.RequestHash(req)
		d.ResponseKind = req.Response.Kind
		var err error
		d.Sig, err = wire.Sign(signer.priv, wire.BoundDecisionSigningMessage(d))
		if err != nil {
			t.Error(err)
			return
		}
		if mutate != nil {
			mutate(&d)
		}
		pushBox(t, f, key, d)
	}()
}

func decisionFor(req wire.Request, result wire.Result) wire.Decision {
	return wire.Decision{
		Kind: wire.KindDecision, Protocol: wire.Protocol, Room: req.Room, ID: req.ID,
		RequestHash: wire.RequestHash(req), ResponseKind: req.Response.Kind, Result: result,
	}
}

func signFor(t *testing.T, signer deviceSigner, req wire.Request, result wire.Result) wire.Decision {
	t.Helper()
	d := decisionFor(req, result)
	var err error
	d.Sig, err = wire.Sign(signer.priv, wire.BoundDecisionSigningMessage(d))
	require.NoError(t, err)
	return d
}

func activeRequest(t *testing.T, a *Agent) wire.Request {
	t.Helper()
	a.waiterMu.Lock()
	defer a.waiterMu.Unlock()
	require.NotNil(t, a.waiter)
	return a.waiter.req
}

func TestProtocolMissingIdentityFailsClosed(t *testing.T) {
	a := pairedAgent(t, make([]byte, 32), newFakeConn(), nil)
	a.sess.devicePub = nil
	_, err := a.Ask(context.Background(), yesnoReq())
	require.ErrorContains(t, err, "start_pairing with reset:true")
}
