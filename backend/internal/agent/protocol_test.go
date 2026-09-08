package agent

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"

	"github.com/askahuman/askahuman/backend/pkg/sealedbox"
	"github.com/askahuman/askahuman/backend/pkg/wire"
)

type stalledAckConn struct {
	*fakeConn
	key     []byte
	started chan struct{}
	release chan struct{}
}

func (f *stalledAckConn) writeFrame(ctx context.Context, raw []byte) error {
	var env envelope
	if json.Unmarshal(raw, &env) == nil && env.Box != "" {
		if plain, e := sealedbox.Open(f.key, env.Box); e == nil {
			var ack wire.Ack
			if wire.StrictDecode(plain, &ack) == nil && ack.Kind == wire.KindAck {
				close(f.started)
				select {
				case <-f.release:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
		}
	}
	return f.fakeConn.writeFrame(ctx, raw)
}

func TestProtocolCommittedAnswerDoesNotWaitForReceiptWrite(t *testing.T) {
	key := make([]byte, 32)
	conn := &stalledAckConn{fakeConn: newFakeConn(), key: key, started: make(chan struct{}), release: make(chan struct{})}
	a := pairedAgent(t, key, conn, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	answerBox(t, a, conn.fakeConn, key, wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: boolPtr(false)}})
	result := make(chan error, 1)
	go func() {
		d, e := a.Ask(ctx, yesnoReq())
		if e == nil && (d.Result.Approved == nil || *d.Result.Approved) {
			e = io.ErrUnexpectedEOF
		}
		result <- e
	}()
	select {
	case <-conn.started:
	case <-time.After(time.Second):
		t.Fatal("receipt write not started")
	}
	select {
	case err := <-result:
		require.NoError(t, err)
	case <-time.After(50 * time.Millisecond):
		t.Fatal("committed MCP answer waited on receipt I/O")
	}
	<-ctx.Done()
	close(conn.release)
	require.Eventually(t, func() bool { return conn.writeCount() >= 2 }, time.Second, time.Millisecond)
	conn.mu.Lock()
	raw := append([]byte(nil), conn.writes[1]...)
	conn.mu.Unlock()
	var env envelope
	require.NoError(t, json.Unmarshal(raw, &env))
	plain, e := sealedbox.Open(key, env.Box)
	require.NoError(t, e)
	var ack wire.Ack
	require.NoError(t, wire.StrictDecode(plain, &ack))
	require.Equal(t, "accepted", ack.Status)
	require.True(t, wire.Verify(&a.sess.agentSigner.PublicKey, wire.AckSigningMessage(ack), ack.Sig))
}

func TestProtocolBoundedReceiptsReackOnlyExactDecisions(t *testing.T) {
	a := pairedAgent(t, make([]byte, 32), newFakeConn(), nil)
	a.sess.ackQueue = make(chan []byte, 64)
	phone := testPhone(t, a)
	var first, last wire.Decision
	for i := 0; i < maxReceipts+1; i++ {
		r := yesnoReq()
		r.ID = strings.Repeat("x", i+1)
		var e error
		r, e = prepareRequest(context.Background(), r, a.sess)
		require.NoError(t, e)
		d := signFor(t, phone, r, wire.Result{Approved: boolPtr(false)})
		_, e = a.commitDecision(context.Background(), a.sess, d)
		require.NoError(t, e)
		if i == 0 {
			first = d
		}
		last = d
	}
	require.Len(t, a.sess.receipts, maxReceipts)
	for len(a.sess.ackQueue) > 0 {
		<-a.sess.ackQueue
	}
	for _, tc := range []struct {
		d    wire.Decision
		want string
	}{{last, "accepted"}, {first, "unknown"}} {
		raw, e := wire.EncodeDecision(tc.d)
		require.NoError(t, e)
		a.routeDecision(a.sess, raw)
		var ack wire.Ack
		require.NoError(t, wire.StrictDecode(<-a.sess.ackQueue, &ack))
		require.Equal(t, tc.want, ack.Status)
		require.Equal(t, wire.DecisionHash(tc.d), ack.DecisionHash)
		require.True(t, wire.Verify(&a.sess.agentSigner.PublicKey, wire.AckSigningMessage(ack), ack.Sig))
	}
	last.Result.Approved = boolPtr(true)
	var e error
	last.Sig, e = wire.Sign(phone.priv, wire.BoundDecisionSigningMessage(last))
	require.NoError(t, e)
	raw, e := wire.EncodeDecision(last)
	require.NoError(t, e)
	a.routeDecision(a.sess, raw)
	var ack wire.Ack
	require.NoError(t, wire.StrictDecode(<-a.sess.ackQueue, &ack))
	require.Equal(t, "unknown", ack.Status, "a conflicting answer is not the cached accepted answer")
}

func TestProtocolRejectsInvalidMCPBeforePairing(t *testing.T) {
	a, e := New(Config{})
	require.NoError(t, e)
	h := NewMCPServer(a, io.Discard)
	pairs := 0
	h.pair = func(context.Context) error { pairs++; return nil }
	for _, raw := range []string{`{"title":"T","summary":"S","response_kind":"yesno","max_len":0}`, `{"title":"\ud800","summary":"S","response_kind":"yesno"}`, `{"title":"T","title":"other","summary":"S","response_kind":"yesno"}`, `{"title":"T","summary":"S","response_kind":"choice","options":["x","x"]}`, `{"title":"T","summary":"S","response_kind":"text","max_len":4097}`} {
		call := &mcp.CallToolRequest{Params: &mcp.CallToolParamsRaw{Arguments: json.RawMessage(raw)}}
		_, _, e := h.requestApproval(context.Background(), call, ApprovalInput{})
		require.Error(t, e)
		require.Zero(t, pairs)
	}
	input := ApprovalInput{Title: "T", Summary: strings.Repeat("😀", 4096), ResponseKind: "yesno"}
	_, _, e = h.requestApproval(context.Background(), nil, input)
	require.Error(t, e)
	require.Zero(t, pairs, "aggregate encoded size is checked before any pairing action")
}
