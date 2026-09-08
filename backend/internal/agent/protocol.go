package agent

import (
	"context"
	"errors"
	"fmt"

	"github.com/askahuman/askahuman/backend/pkg/sealedbox"
	"github.com/askahuman/askahuman/backend/pkg/wire"
)

const maxReceipts = 32

func prepareRequest(ctx context.Context, req wire.Request, sess *Session) (wire.Request, error) {
	if sess.protocol != wire.Protocol || sess.agentSigner == nil || sess.devicePub == nil {
		return req, errors.New(wire.UpgradeMessage)
	}
	req.Kind = wire.KindRequest
	req.Protocol = wire.Protocol
	req.Room = sess.roomID
	for {
		previous := sess.requestSeq.Load()
		if previous < 0 || previous >= wire.MaxSafeInteger {
			return req, errors.New("agent: request sequence exhausted; " + wire.UpgradeMessage)
		}
		if sess.requestSeq.CompareAndSwap(previous, previous+1) {
			req.RequestSeq = previous + 1
			break
		}
	}
	req.DeadlineMS = 0
	if deadline, ok := ctx.Deadline(); ok {
		// The signed wall-clock deadline is informative on the phone. The agent
		// continues enforcing the original context's monotonic deadline.
		req.DeadlineMS = deadline.UnixMilli()
	}
	if err := wire.ValidateRequest(req); err != nil {
		return req, err
	}
	sig, err := wire.Sign(sess.agentSigner, wire.RequestSigningMessage(req))
	req.Sig = sig
	return req, err
}

func signedAck(sess *Session, dec wire.Decision, status string) (wire.Ack, error) {
	ack := wire.Ack{
		Kind: wire.KindAck, Protocol: wire.Protocol, Room: sess.roomID, ID: dec.ID,
		RequestHash: dec.RequestHash, DecisionHash: wire.DecisionHash(dec), Status: status,
	}
	sig, err := wire.Sign(sess.agentSigner, wire.AckSigningMessage(ack))
	ack.Sig = sig
	return ack, err
}

// commitDecision is the ONLY acceptance point. Signing the prospective receipt
// happens before the final time check. Once committed, the result returns
// immediately even if acknowledgement delivery stalls or the caller cancels.
func (a *Agent) commitDecision(ctx context.Context, sess *Session, dec wire.Decision) (wire.Decision, error) {
	ack, err := signedAck(sess, dec, "accepted")
	if err != nil {
		return wire.Decision{}, fmt.Errorf("agent: receipt: %w", err)
	}
	a.waiterMu.Lock()
	if requestExpired(ctx) {
		a.waiterMu.Unlock()
		if expired, e := signedAck(sess, dec, "expired"); e == nil {
			a.queueAck(sess, expired)
		}
		return wire.Decision{}, a.timeoutErr()
	}
	// This state change is the acceptance commit. No later context check may
	// turn this into a timeout. Receipts retain only hashes, never answer text.
	if sess.receipts == nil {
		sess.receipts = make(map[string]wire.Ack)
	}
	sess.receipts[ack.RequestHash] = ack
	sess.receiptOrder = append(sess.receiptOrder, ack.RequestHash)
	if len(sess.receiptOrder) > maxReceipts {
		delete(sess.receipts, sess.receiptOrder[0])
		sess.receiptOrder = sess.receiptOrder[1:]
	}
	a.waiterMu.Unlock()
	a.queueAck(sess, ack)
	return dec, nil
}

func (a *Agent) queueAck(sess *Session, ack wire.Ack) {
	plain, err := wire.EncodeMessage(ack)
	if err != nil {
		return
	}
	select {
	case sess.ackQueue <- plain:
	default:
	} // retryable; never blocks Ask.
}

func (a *Agent) ackLoop(ctx context.Context, sess *Session) {
	for {
		select {
		case <-ctx.Done():
			return
		case plain := <-sess.ackQueue:
			box, err := sealedbox.Seal(sess.key, plain)
			if err != nil {
				continue
			}
			writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
			_ = writeEnvelope(writeCtx, sess.currentConn(), envelope{Box: box})
			cancel()
		}
	}
}

// routeBoundDecision verifies the device identity before even consulting the
// receipt cache. Exact duplicates can recover a lost ack without re-authorizing
// anything. Unknown/evicted requests can only receive an uncertain receipt.
func (a *Agent) routeBoundDecision(sess *Session, plain []byte) {
	var dec wire.Decision
	if wire.StrictDecode(plain, &dec) != nil || wire.ValidateDecision(dec) != nil ||
		!resultFieldsMatch(plain, dec.ResponseKind) || !verifyDecisionSig(sess, dec) {
		return
	}
	a.waiterMu.Lock()
	ack, found := sess.receipts[dec.RequestHash]
	w := a.waiter
	if found && ack.ID == dec.ID && ack.DecisionHash == wire.DecisionHash(dec) {
		a.waiterMu.Unlock()
		a.queueAck(sess, ack)
		return
	}
	if w == nil || w.req.ID != dec.ID || wire.RequestHash(w.req) != dec.RequestHash {
		a.waiterMu.Unlock()
		if ack, err := signedAck(sess, dec, "unknown"); err == nil {
			a.queueAck(sess, ack)
		}
		return
	}
	if dec.ResponseKind != w.req.Response.Kind || !resultMatchesKind(dec.Result, w.req.Response) {
		a.waiterMu.Unlock()
		return
	}
	// Deliberately leave the definitive context check to commitDecision. It is
	// possible for an initial request write/re-announcement to remain stalled.
	select {
	case w.decCh <- dec:
	default:
	}
	a.waiterMu.Unlock()
}
