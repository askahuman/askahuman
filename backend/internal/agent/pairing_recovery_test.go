package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/askahuman/askahuman/backend/pkg/sealedbox"
	"github.com/askahuman/askahuman/backend/pkg/wire"
)

// Signals when ensurePaired reaches its wait select, avoiding sleeps when
// coordinating multiple callers attached to the same attempt.
type pairingWaitContext struct {
	context.Context
	waiting chan struct{}
	once    sync.Once
}

func (c *pairingWaitContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}

func TestPairingFailureReleasesAllWaitersAndAllowsRetry(t *testing.T) {
	ag := &Agent{}
	h := NewMCPServer(ag, io.Discard)
	entered, release := make(chan struct{}), make(chan struct{})
	finish := sync.OnceFunc(func() { close(release) })
	t.Cleanup(finish)
	failed := errors.New("pairing confirmation rejected")
	var attempts atomic.Int32
	h.SetPairFunc(func(context.Context) error {
		if attempts.Add(1) == 1 {
			close(entered)
			<-release
			return failed
		}
		ag.mu.Lock()
		ag.sess = &Session{conn: newFakeConn()}
		ag.mu.Unlock()
		return nil
	})
	t.Cleanup(ag.Close)
	leader := make(chan error, 1)
	go func() { leader <- h.ensurePaired(context.Background()) }()
	<-entered
	const count = 24
	results := make(chan error, count)
	for range count {
		ctx := &pairingWaitContext{Context: context.Background(), waiting: make(chan struct{})}
		go func() { results <- h.ensurePaired(ctx) }()
		<-ctx.waiting
	}
	finish()
	require.ErrorIs(t, <-leader, failed)
	for range count {
		select {
		case err := <-results:
			require.ErrorIs(t, err, failed)
		case <-time.After(time.Second):
			t.Fatal("a concurrent caller remained blocked after pairing failed")
		}
	}
	require.NoError(t, h.ensurePaired(context.Background()))
	assert.Equal(t, int32(2), attempts.Load(), "a fresh attempt must be possible")
	assert.True(t, ag.Paired())
}

func TestPairingWaiterCancellationDoesNotCancelSharedAttempt(t *testing.T) {
	h := NewMCPServer(&Agent{}, io.Discard)
	entered, release := make(chan struct{}), make(chan struct{})
	finish := sync.OnceFunc(func() { close(release) })
	t.Cleanup(finish)
	failed := errors.New("shared attempt finished")
	h.SetPairFunc(func(context.Context) error { close(entered); <-release; return failed })
	leader := make(chan error, 1)
	go func() { leader <- h.ensurePaired(context.Background()) }()
	<-entered
	ctx, cancel := context.WithCancel(context.Background())
	waiterCtx := &pairingWaitContext{Context: ctx, waiting: make(chan struct{})}
	waiter := make(chan error, 1)
	go func() { waiter <- h.ensurePaired(waiterCtx) }()
	<-waiterCtx.waiting
	cancel()
	require.ErrorIs(t, <-waiter, context.Canceled)
	select {
	case err := <-leader:
		t.Fatalf("canceling one waiter ended the shared attempt: %v", err)
	default:
	}
	finish()
	require.ErrorIs(t, <-leader, failed)
}

func resetPairingInput(t *testing.T) StartPairingInput {
	t.Helper()
	var in StartPairingInput
	require.NoError(t, json.Unmarshal([]byte(`{"reset":true}`), &in))
	return in
}

func TestStartPairingExplicitResetClearsOldSession(t *testing.T) {
	conn := newFakeConn()
	ag := pairedAgent(t, make([]byte, sealedbox.KeySize), conn, nil)
	old := ag.sess
	signer := newDeviceSigner(t)
	old.devicePub = &signer.priv.PublicKey
	ag.sub = &webpush.Subscription{Endpoint: "https://old.example.invalid/push"}
	ag.setPeerPresent(true)
	ag.ensureReader(old)
	h := NewMCPServer(ag, io.Discard)
	entered, release := make(chan struct{}), make(chan struct{})
	finish := sync.OnceFunc(func() { close(release) })
	t.Cleanup(finish)
	h.SetPairFunc(func(context.Context) error { close(entered); <-release; return errors.New("test stopped") })

	// Routine pairing/status queries preserve the original session and pin.
	_, _, err := h.startPairing(context.Background(), nil, StartPairingInput{})
	require.NoError(t, err)
	_ = pairStatusText(t, h)
	assert.Same(t, old, ag.sess)
	assert.Same(t, &signer.priv.PublicKey, ag.sess.devicePub)

	_, _, err = h.startPairing(context.Background(), nil, resetPairingInput(t))
	require.NoError(t, err)
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("explicit reset did not start a fresh pairing attempt")
	}
	assert.False(t, ag.Paired())
	assert.Nil(t, ag.sub)
	assert.False(t, ag.peerPresent.Load())
	assert.Nil(t, ag.readerSess)
	conn.mu.Lock()
	assert.True(t, conn.closed, "the abandoned session must be disconnected")
	conn.mu.Unlock()
	finish()
}

func TestStartPairingResetRefusesActiveApproval(t *testing.T) {
	key := make([]byte, sealedbox.KeySize)
	conn := newFakeConn()
	ag := pairedAgent(t, key, conn, nil)
	old := ag.sess
	h := NewMCPServer(ag, io.Discard)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	answered := make(chan error, 1)
	go func() { _, err := ag.Ask(ctx, yesnoReq()); answered <- err }()
	require.Eventually(t, func() bool { return conn.writeCount() > 0 }, time.Second, time.Millisecond)
	_, _, err := h.startPairing(ctx, nil, resetPairingInput(t))
	require.ErrorIs(t, err, ErrBusy)
	assert.Same(t, old, ag.sess)
	answerBox(t, ag, conn, key, wire.Decision{Kind: wire.KindDecision, ID: "req_1", Result: wire.Result{Approved: boolPtr(false)}})
	require.NoError(t, <-answered, "the original approval must remain answerable")
}

func TestPairStatusDistinguishesSessionFromPresence(t *testing.T) {
	ag := pairedAgent(t, make([]byte, sealedbox.KeySize), newFakeConn(), nil)
	h := NewMCPServer(ag, io.Discard)
	ag.setPeerPresent(false)
	status := pairStatusText(t, h)
	assert.Contains(t, status, "paired")
	assert.Contains(t, status, "offline")
	assert.NotContains(t, status, "the phone is connected")
	assert.Contains(t, status, "reset")
}

func TestConcurrentExplicitResetsJoinOneFreshAttempt(t *testing.T) {
	ag := pairedAgent(t, make([]byte, sealedbox.KeySize), newFakeConn(), nil)
	h := NewMCPServer(ag, io.Discard)
	entered, release := make(chan struct{}), make(chan struct{})
	finish := sync.OnceFunc(func() { close(release) })
	t.Cleanup(finish)
	var attempts atomic.Int32
	h.SetPairFunc(func(context.Context) error {
		attempts.Add(1)
		close(entered)
		<-release
		return errors.New("test stopped")
	})
	_, _, err := h.startPairing(context.Background(), nil, resetPairingInput(t))
	require.NoError(t, err)
	<-entered
	const count = 24
	results := make(chan error, count)
	for range count {
		go func() {
			_, _, err := h.startPairing(context.Background(), nil, StartPairingInput{Reset: true})
			results <- err
		}()
	}
	for range count {
		require.NoError(t, <-results)
	}
	assert.Equal(t, int32(1), attempts.Load())
	finish()
}

func TestResetRefusesApprovalWaitingForPairing(t *testing.T) {
	h := NewMCPServer(&Agent{}, io.Discard)
	entered, release := make(chan struct{}), make(chan struct{})
	finish := sync.OnceFunc(func() { close(release) })
	t.Cleanup(finish)
	failed := errors.New("test pairing failed")
	h.SetPairFunc(func(context.Context) error { close(entered); <-release; return failed })
	result := make(chan error, 1)
	go func() {
		_, _, err := h.requestApproval(context.Background(), nil, ApprovalInput{ResponseKind: "yesno"})
		result <- err
	}()
	<-entered
	_, _, err := h.startPairing(context.Background(), nil, StartPairingInput{Reset: true})
	require.ErrorIs(t, err, ErrBusy)
	finish()
	require.ErrorIs(t, <-result, failed)
	h.mu.Lock()
	assert.Zero(t, h.pendingRequests, "a failed approval must release its reset guard")
	h.mu.Unlock()
}
