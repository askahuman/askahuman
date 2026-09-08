package agent

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/askahuman/askahuman/backend/pkg/sealedbox"
	"github.com/askahuman/askahuman/backend/pkg/wire"
)

// stalledResendConn lets the original question reach the phone, then holds a
// reconnect re-announcement while the request expires and a signed answer is
// delivered. The independent session reader continues to service incoming data.
type stalledResendConn struct {
	*fakeConn
	writesStarted atomic.Int32
	firstSent     chan struct{}
	resendStarted chan struct{}
	release       chan struct{}
}

func (f *stalledResendConn) writeFrame(ctx context.Context, b []byte) error {
	switch f.writesStarted.Add(1) {
	case 1:
		err := f.fakeConn.writeFrame(ctx, b)
		close(f.firstSent)
		return err
	case 2:
		close(f.resendStarted)
		select {
		case <-f.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return f.fakeConn.writeFrame(ctx, b)
}

func TestAskRejectsSignedAnswerAfterExpiryDuringResend(t *testing.T) {
	// Before the acceptance guard, both ctx.Done and decCh are ready after the
	// stalled write, so select randomly accepts roughly half of these answers.
	// Repeating the controlled schedule covers that nondeterministic selection.
	for _, cause := range []string{"deadline", "cancellation"} {
		t.Run(cause, func(t *testing.T) {
			for range 40 {
				key := make([]byte, sealedbox.KeySize)
				conn := &stalledResendConn{
					fakeConn: newFakeConn(), firstSent: make(chan struct{}),
					resendStarted: make(chan struct{}), release: make(chan struct{}),
				}
				a := pairedAgent(t, key, conn, nil)
				release := sync.OnceFunc(func() { close(conn.release) })
				t.Cleanup(release)
				signer := newDeviceSigner(t)
				a.sess.devicePub = &signer.priv.PublicKey // pin before the reader starts.
				dec := wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: boolPtr(true)}}
				dec.Sig = signer.sign(t, "room1", dec)

				var ctx context.Context
				var cancel context.CancelFunc
				if cause == "deadline" {
					ctx, cancel = context.WithTimeout(context.Background(), 50*time.Millisecond)
				} else {
					ctx, cancel = context.WithCancel(context.Background())
				}
				t.Cleanup(cancel)
				result := make(chan struct {
					dec wire.Decision
					err error
				}, 1)
				go func() {
					got, err := a.Ask(ctx, yesnoReq())
					result <- struct {
						dec wire.Decision
						err error
					}{got, err}
				}()
				select {
				case <-conn.firstSent:
				case <-time.After(time.Second):
					cancel()
					t.Fatal("initial question was not sent")
				}
				a.notifyWaiter(evReconnected)
				select {
				case <-conn.resendStarted:
				case <-time.After(time.Second):
					cancel()
					t.Fatal("re-announcement did not start")
				}
				if cause == "cancellation" {
					cancel()
				}
				<-ctx.Done()
				pushBox(t, conn.fakeConn, key, dec) // cannot precede expiry/cancellation.
				a.waiterMu.Lock()
				waiter := a.waiter
				a.waiterMu.Unlock()
				queued := assert.Eventually(t, func() bool { return len(waiter.decCh) == 1 }, time.Second, time.Millisecond)
				release()
				got := <-result
				cancel()
				a.Close()
				require.True(t, queued, "the correctly signed answer must actually reach the mailbox")
				require.ErrorIs(t, got.err, ErrTimeout)
				require.Equal(t, wire.Decision{}, got.dec, "an expired request must never return an answer")
			}
		})
	}
}

// A context's deadline can elapse before its timer goroutine publishes Err/Done.
// Keep that notification pending to verify the timestamp is authoritative.
type unpublishedDeadlineContext struct {
	context.Context
	deadline time.Time
}

func (c unpublishedDeadlineContext) Deadline() (time.Time, bool) { return c.deadline, true }

func TestAskRejectsDeadlineBeforeCancellationIsPublished(t *testing.T) {
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()
	a := pairedAgent(t, key, conn, nil)
	signer := newDeviceSigner(t)
	a.sess.devicePub = &signer.priv.PublicKey
	dec := wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: boolPtr(true)}}
	dec.Sig = signer.sign(t, "room1", dec)
	pushBox(t, conn, key, dec)
	ctx := unpublishedDeadlineContext{Context: context.Background(), deadline: time.Now().Add(-time.Second)}
	require.NoError(t, ctx.Err(), "the cancellation notification is deliberately pending")
	got, err := a.Ask(ctx, yesnoReq())
	require.ErrorIs(t, err, ErrTimeout)
	assert.Equal(t, wire.Decision{}, got)
	assert.Zero(t, conn.writeCount(), "an expired question must not be sent")
}

func TestAskDoesNotSendCanceledRequest(t *testing.T) {
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()
	a := pairedAgent(t, key, conn, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, err := a.Ask(ctx, yesnoReq())
	require.ErrorIs(t, err, ErrTimeout)
	assert.Equal(t, wire.Decision{}, got)
	assert.Zero(t, conn.writeCount())
}

func TestDecodeDecisionRejectsUnsignedExtraResultFields(t *testing.T) {
	signer := newDeviceSigner(t)
	sess := &Session{roomID: "room1", devicePub: &signer.priv.PublicKey}
	tests := []struct {
		name     string
		response wire.Response
		original wire.Result
		changed  wire.Result
	}{
		{
			name: "decline with added choice and text", response: wire.Response{Kind: wire.ResponseYesNo},
			original: wire.Result{Approved: boolPtr(false)},
			changed:  wire.Result{Approved: boolPtr(false), Choice: "Proceed", Text: "unsigned instruction"},
		},
		{
			name: "choice with added text", response: wire.Response{Kind: wire.ResponseChoice, Options: []string{"Stop", "Proceed"}},
			original: wire.Result{Choice: "Stop"}, changed: wire.Result{Choice: "Stop", Text: "unsigned instruction"},
		},
		{
			name: "text accompanied by a signed boolean", response: wire.Response{Kind: wire.ResponseText},
			original: wire.Result{Approved: boolPtr(false)}, changed: wire.Result{Approved: boolPtr(false), Text: "unsigned instruction"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dec := wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: tt.original}
			dec.Sig = signer.sign(t, sess.roomID, dec)
			dec.Result = tt.changed // the added fields are deliberately never signed.
			require.True(t, verifyDecisionSig(sess, dec), "control: the old signature still verifies")
			raw, err := json.Marshal(dec)
			require.NoError(t, err)
			got, ok := decodeDecision(raw, wire.Request{ID: dec.ID, Response: tt.response}, sess)
			assert.False(t, ok)
			assert.Equal(t, wire.Decision{}, got)
		})
	}
}

func TestDecodeDecisionRequiresExactResultFields(t *testing.T) {
	signer := newDeviceSigner(t)
	sess := &Session{roomID: "room1", devicePub: &signer.priv.PublicKey}
	tests := []struct {
		name     string
		kind     wire.ResponseKind
		result   string
		signed   wire.Result
		accepted bool
	}{
		{"decline", wire.ResponseYesNo, `{"approved":false}`, wire.Result{Approved: boolPtr(false)}, true},
		{"empty text", wire.ResponseText, `{"text":""}`, wire.Result{}, true},
		{"empty text from Go omitempty codec", wire.ResponseText, `{}`, wire.Result{}, true},
		{"choice", wire.ResponseChoice, `{"choice":"Stop"}`, wire.Result{Choice: "Stop"}, true},
		{"empty extra text", wire.ResponseYesNo, `{"approved":false,"text":""}`, wire.Result{Approved: boolPtr(false)}, false},
		{"null extra approval", wire.ResponseText, `{"text":"hello","approved":null}`, wire.Result{Text: "hello"}, false},
		{"unknown field", wire.ResponseText, `{"text":"hello","instruction":"run this"}`, wire.Result{Text: "hello"}, false},
		{"case variant", wire.ResponseYesNo, `{"Approved":false}`, wire.Result{Approved: boolPtr(false)}, false},
		{"null text", wire.ResponseText, `{"text":null}`, wire.Result{}, false},
		{"null result", wire.ResponseText, `null`, wire.Result{}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dec := wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: tt.signed}
			sig := signer.sign(t, sess.roomID, dec)
			raw, err := json.Marshal(struct {
				Kind   wire.MessageKind `json:"kind"`
				ID     string           `json:"id"`
				Result json.RawMessage  `json:"result"`
				Sig    string           `json:"sig"`
			}{dec.Kind, dec.ID, json.RawMessage(tt.result), sig})
			require.NoError(t, err)
			req := wire.Request{ID: dec.ID, Response: wire.Response{Kind: tt.kind, Options: []string{"Stop"}}}
			got, ok := decodeDecision(raw, req, sess)
			assert.Equal(t, tt.accepted, ok)
			if tt.accepted {
				assert.Equal(t, tt.signed, got.Result)
			} else {
				assert.Equal(t, wire.Decision{}, got)
			}
		})
	}
}
