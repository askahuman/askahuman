package agent

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/askahuman/askahuman/backend/pkg/spake2"
	"github.com/askahuman/askahuman/backend/pkg/wire"
)

// envelope is the relay-visible frame as it travels on the wire. It mirrors
// the JS twin (frontend/src/lib/wire.ts): the relay reads only Relay and
// forwards Pake/Confirm/Box verbatim. The frozen pkg/wire.Frame omits
// Confirm (the agreed key-confirmation frame), so the agent carries its own
// envelope here to stay byte-compatible with the PWA. Do not diverge.
type envelope struct {
	Relay   wire.RelaySignal `json:"_relay,omitempty"`
	Pake    string           `json:"pake,omitempty"`
	Confirm string           `json:"confirm,omitempty"`
	Box     string           `json:"box,omitempty"`
}

// ErrPairing is returned when the SPAKE2 handshake fails (bad peer message,
// confirmation mismatch, or a transport error during pairing).
var ErrPairing = errors.New("agent: pairing failed")

// Session is a paired channel: a live relay connection plus the SPAKE2
// session key. It is the result of Pair and the input to Ask.
type Session struct {
	relayURL string
	roomID   string
	code     string
	key      []byte
	conn     frameConn
	dial     dialer
}

// SessionKey returns the 32-byte SPAKE2-derived key.
func (s *Session) SessionKey() []byte { return s.key }

// RoomID returns the room id the session is paired in.
func (s *Session) RoomID() string { return s.roomID }

// Close tears down the relay connection.
func (s *Session) Close() error {
	if s.conn == nil {
		return nil
	}
	return s.conn.close()
}

// NewReqID returns a collision-resistant request id of the form
// req_<unixnanos>_<hex>. The nanos give rough ordering; the random suffix
// removes the collision risk of nanos alone (two requests minted in the same
// nanosecond, or a clock that does not advance per call).
func NewReqID() (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("agent: req id: %w", err)
	}
	return fmt.Sprintf("req_%d_%s", time.Now().UnixNano(), hex.EncodeToString(b[:])), nil
}

// pairAsA runs the SPAKE2 A-side handshake over the relay and returns a
// paired Session. Protocol (matches frontend/src/lib/pairing.ts):
//  1. send {pake: Start()}.
//  2. on peer {pake} -> Finish -> send {confirm}.
//  3. on peer {confirm} -> Confirm() -> paired.
//
// code MUST already be the canonical code (paircode.Canonicalize): it is the
// SPAKE2 password and must be byte-identical to the phone's, which derives it
// from the same canonical form. A peer confirm may race ahead of the peer
// pake; it is buffered and verified once Finish has run.
func pairAsA(ctx context.Context, dial dialer, relayURL, roomID, code string) (*Session, error) {
	conn, err := dial(ctx, relayURL, roomID)
	if err != nil {
		return nil, err
	}

	hs := spake2.NewA(code)
	pake, err := hs.Start()
	if err != nil {
		_ = conn.close()
		return nil, fmt.Errorf("%w: start: %w", ErrPairing, err)
	}
	if err := writeEnvelope(ctx, conn, envelope{Pake: b64(pake)}); err != nil {
		_ = conn.close()
		return nil, fmt.Errorf("%w: send pake: %w", ErrPairing, err)
	}

	var (
		finished       bool
		pendingConfirm []byte
	)
	for {
		env, err := readEnvelope(ctx, conn)
		if err != nil {
			_ = conn.close()
			return nil, fmt.Errorf("%w: read: %w", ErrPairing, err)
		}
		switch {
		case env.Relay == wire.SignalPeerJoined:
			// The peer just (re)joined: our earlier pake may have been
			// dropped as undeliverable before they arrived. Re-send the SAME
			// pake (never re-randomize mid-flow) so they can finish.
			if werr := writeEnvelope(ctx, conn, envelope{Pake: b64(pake)}); werr != nil {
				_ = conn.close()
				return nil, fmt.Errorf("%w: resend pake: %w", ErrPairing, werr)
			}
			continue
		case env.Relay != "":
			// peer_left/undeliverable: keep waiting for crypto frames.
			continue
		case env.Pake != "":
			if finished {
				continue // duplicate pake after a resend; already finished.
			}
			peer, derr := base64.StdEncoding.DecodeString(env.Pake)
			if derr != nil {
				_ = conn.close()
				return nil, fmt.Errorf("%w: bad pake b64: %w", ErrPairing, derr)
			}
			_, confirm, ferr := hs.Finish(peer)
			if ferr != nil {
				_ = conn.close()
				return nil, fmt.Errorf("%w: finish: %w", ErrPairing, ferr)
			}
			finished = true
			if werr := writeEnvelope(ctx, conn, envelope{Confirm: b64(confirm)}); werr != nil {
				_ = conn.close()
				return nil, fmt.Errorf("%w: send confirm: %w", ErrPairing, werr)
			}
			if pendingConfirm != nil {
				if cerr := hs.Confirm(pendingConfirm); cerr != nil {
					_ = conn.close()
					return nil, fmt.Errorf("%w: confirm: %w", ErrPairing, cerr)
				}
				return pairedSession(relayURL, roomID, code, hs.SessionKey(), conn, dial), nil
			}
		case env.Confirm != "":
			peerConfirm, derr := base64.StdEncoding.DecodeString(env.Confirm)
			if derr != nil {
				_ = conn.close()
				return nil, fmt.Errorf("%w: bad confirm b64: %w", ErrPairing, derr)
			}
			if !finished {
				pendingConfirm = peerConfirm
				continue
			}
			if cerr := hs.Confirm(peerConfirm); cerr != nil {
				_ = conn.close()
				return nil, fmt.Errorf("%w: confirm: %w", ErrPairing, cerr)
			}
			return pairedSession(relayURL, roomID, code, hs.SessionKey(), conn, dial), nil
		}
	}
}

func pairedSession(relayURL, roomID, code string, key []byte, conn frameConn, dial dialer) *Session {
	return &Session{
		relayURL: relayURL,
		roomID:   roomID,
		code:     code,
		key:      key,
		conn:     conn,
		dial:     dial,
	}
}

// b64 is std-base64; the JS twin uses the same alphabet for handshake frames.
func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func writeEnvelope(ctx context.Context, conn frameConn, env envelope) error {
	b, err := json.Marshal(env)
	if err != nil {
		return err
	}
	return conn.writeFrame(ctx, b)
}

func readEnvelope(ctx context.Context, conn frameConn) (envelope, error) {
	data, err := conn.readFrame(ctx)
	if err != nil {
		return envelope{}, err
	}
	var env envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return envelope{}, fmt.Errorf("agent: decode frame: %w", err)
	}
	return env, nil
}
