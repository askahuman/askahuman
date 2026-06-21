package spake2

import (
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/gtank/ristretto255"
)

// Domain-separation labels. These bytes are part of the wire contract and
// must be byte-identical on the JS side. Changing any of them breaks interop.
const (
	// seedM derives the fixed point M used by role A (the agent).
	seedM = "ask-a-human:spake2:M"
	// seedN derives the fixed point N used by role B (the phone).
	seedN = "ask-a-human:spake2:N"
	// idA is the agent identity mixed into the transcript.
	idA = "ask-a-human:agent"
	// idB is the phone identity mixed into the transcript.
	idB = "ask-a-human:phone"
	// infoSession derives the 32-byte session key from the transcript hash.
	infoSession = "ask-a-human:session-key"
	// infoKcA derives A's confirmation MAC key.
	infoKcA = "ask-a-human:kc:A"
	// infoKcB derives B's confirmation MAC key.
	infoKcB = "ask-a-human:kc:B"
)

// KeySize is the derived session key length in bytes.
const KeySize = 32

// MsgSize is the wire length of a SPAKE2 message (a ristretto255 element).
const MsgSize = 32

// ConfirmSize is the wire length of a key-confirmation MAC (HMAC-SHA256).
const ConfirmSize = sha256.Size

// Role selects which fixed point a peer blinds with and which confirmation
// key it sends. A is the agent (uses M); B is the phone (uses N).
type Role string

// SPAKE2 roles.
const (
	// RoleA is the agent; it blinds with M and sends T.
	RoleA Role = "A"
	// RoleB is the phone; it blinds with N and sends S.
	RoleB Role = "B"
)

// Roles lists every valid Role.
var Roles = []Role{RoleA, RoleB}

// ValidRole reports whether r is a known role.
func ValidRole(r Role) bool {
	switch r {
	case RoleA, RoleB:
		return true
	default:
		return false
	}
}

// Sentinel errors. Wrap once with %w; match with errors.Is.
var (
	// ErrNotStarted means Finish or Confirm was called before Start.
	ErrNotStarted = errors.New("spake2: start not called")
	// ErrNotFinished means Confirm was called before Finish.
	ErrNotFinished = errors.New("spake2: finish not called")
	// ErrBadPeerMsg means the peer's SPAKE2 message is not a canonical element.
	ErrBadPeerMsg = errors.New("spake2: peer message is not a canonical ristretto255 element")
	// ErrBadConfirm means the peer's key-confirmation MAC did not verify.
	ErrBadConfirm = errors.New("spake2: peer confirmation MAC mismatch")
)

// pointM returns the fixed point M = map(SHA-512(seedM)). Computed fresh per
// call (cheap, no shared mutable state).
func pointM() *ristretto255.Element {
	d := sha512.Sum512([]byte(seedM))
	return ristretto255.NewElement().FromUniformBytes(d[:])
}

// pointN returns the fixed point N = map(SHA-512(seedN)).
func pointN() *ristretto255.Element {
	d := sha512.Sum512([]byte(seedN))
	return ristretto255.NewElement().FromUniformBytes(d[:])
}

// PasswordScalar derives the password scalar w = reduce(SHA-512(code)) over
// the raw UTF-8 bytes of the pairing code. It is exported so callers and
// vector tooling derive w identically.
func PasswordScalar(code string) *ristretto255.Scalar {
	d := sha512.Sum512([]byte(code))
	// SetUniformBytes reduces the 64 little-endian bytes mod l.
	s, err := ristretto255.NewScalar().SetUniformBytes(d[:])
	if err != nil {
		// SetUniformBytes only errors on a non-64-byte input; sha512 is 64.
		panic(fmt.Sprintf("spake2: password scalar: %v", err))
	}
	return s
}

// State runs one side of a SPAKE2 handshake. Construct with NewA or NewB, then
// call Start -> Finish -> Confirm in order. A State is not safe for concurrent
// use and is single-shot.
type State struct {
	role Role
	w    *ristretto255.Scalar  // password scalar
	mine *ristretto255.Element // own blinding point (M for A, N for B)
	peer *ristretto255.Element // peer's blinding point (N for A, M for B)

	x   *ristretto255.Scalar  // own ephemeral secret
	msg *ristretto255.Element // own outgoing message (T for A, S for B)

	confirmKeySelf []byte // HMAC key for the MAC this side sends
	confirmKeyPeer []byte // HMAC key for the MAC this side verifies
	transcript     []byte // length-prefixed TT, retained for confirmation MACs
	sessionKey     []byte
	sharedK        []byte // K element bytes, retained for vector dumps
}

// NewA constructs the agent side (role A) for the given pairing code.
func NewA(code string) *State { return newState(RoleA, code) }

// NewB constructs the phone side (role B) for the given pairing code.
func NewB(code string) *State { return newState(RoleB, code) }

func newState(role Role, code string) *State {
	s := &State{role: role, w: PasswordScalar(code)}
	if role == RoleA {
		s.mine, s.peer = pointM(), pointN()
		return s
	}
	s.mine, s.peer = pointN(), pointM()
	return s
}

// Start samples a fresh ephemeral secret and returns this side's 32-byte
// SPAKE2 message: A sends T = x*G + w*M; B sends S = y*G + w*N.
func (s *State) Start() ([]byte, error) {
	var b [64]byte
	if _, err := rand.Read(b[:]); err != nil {
		return nil, fmt.Errorf("spake2: sample: %w", err)
	}
	x, err := ristretto255.NewScalar().SetUniformBytes(b[:])
	if err != nil {
		return nil, fmt.Errorf("spake2: scalar: %w", err)
	}
	return s.startWith(x), nil
}

// StartDeterministic is Start with the ephemeral scalar derived from a
// caller-supplied 64-byte uniform seed (reduced mod l), for known-answer
// vectors and tests only. Production code must use Start so the secret is
// freshly random. The seed must be exactly 64 bytes.
func (s *State) StartDeterministic(seed64 []byte) ([]byte, error) {
	x, err := ristretto255.NewScalar().SetUniformBytes(seed64)
	if err != nil {
		return nil, fmt.Errorf("spake2: deterministic scalar: %w", err)
	}
	return s.startWith(x), nil
}

// startWith is Start with an injected ephemeral scalar, for deterministic
// known-answer vectors only. It never fails.
func (s *State) startWith(x *ristretto255.Scalar) []byte {
	s.x = x
	// msg = x*G + w*mine
	xG := ristretto255.NewElement().ScalarBaseMult(x)
	wMine := ristretto255.NewElement().ScalarMult(s.w, s.mine)
	s.msg = ristretto255.NewElement().Add(xG, wMine)
	return s.msg.Bytes()
}

// Finish consumes the peer's 32-byte message, computes the shared point K,
// derives the session key, and returns (sessionKey, confirmMsg). confirmMsg is
// this side's key-confirmation MAC; send it to the peer and verify theirs with
// Confirm before trusting the channel.
func (s *State) Finish(peerMsg []byte) (sessionKey, confirmMsg []byte, err error) {
	if s.msg == nil {
		return nil, nil, ErrNotStarted
	}
	peerEl, err := ristretto255.NewElement().SetCanonicalBytes(peerMsg)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %w", ErrBadPeerMsg, err)
	}

	// K = x*(peerMsg - w*peer). For A: x*(S - w*N). For B: y*(T - w*M).
	wPeer := ristretto255.NewElement().ScalarMult(s.w, s.peer)
	unblinded := ristretto255.NewElement().Subtract(peerEl, wPeer)
	k := ristretto255.NewElement().ScalarMult(s.x, unblinded)
	s.sharedK = k.Bytes()

	// Transcript ordering is canonical (A's S, then T) regardless of role, so
	// both sides hash identical bytes.
	var sBytes, tBytes []byte
	if s.role == RoleA {
		sBytes, tBytes = peerEl.Bytes(), s.msg.Bytes()
	} else {
		sBytes, tBytes = s.msg.Bytes(), peerEl.Bytes()
	}

	s.transcript = buildTranscript(sBytes, tBytes, k.Bytes(), s.w.Bytes())
	ttHash := sha256.Sum256(s.transcript)

	s.sessionKey, err = hkdf.Key(sha256.New, ttHash[:], nil, infoSession, KeySize)
	if err != nil {
		return nil, nil, fmt.Errorf("spake2: session key: %w", err)
	}
	kcA, err := hkdf.Key(sha256.New, ttHash[:], nil, infoKcA, KeySize)
	if err != nil {
		return nil, nil, fmt.Errorf("spake2: kc:A: %w", err)
	}
	kcB, err := hkdf.Key(sha256.New, ttHash[:], nil, infoKcB, KeySize)
	if err != nil {
		return nil, nil, fmt.Errorf("spake2: kc:B: %w", err)
	}

	// Each side signs the transcript with its OWN confirmation key and verifies
	// the peer's MAC under the PEER's key. A sends MAC(kcA); B sends MAC(kcB).
	if s.role == RoleA {
		s.confirmKeySelf, s.confirmKeyPeer = kcA, kcB
	} else {
		s.confirmKeySelf, s.confirmKeyPeer = kcB, kcA
	}

	confirmMsg = mac(s.confirmKeySelf, s.transcript)
	return s.sessionKey, confirmMsg, nil
}

// Confirm verifies the peer's key-confirmation MAC over the transcript. It
// must succeed before the session key is trusted. The comparison is
// constant-time.
func (s *State) Confirm(peerConfirm []byte) error {
	if s.transcript == nil {
		return ErrNotFinished
	}
	want := mac(s.confirmKeyPeer, s.transcript)
	if !hmac.Equal(want, peerConfirm) {
		return ErrBadConfirm
	}
	return nil
}

// SessionKey returns the derived 32-byte key, or nil before Finish.
func (s *State) SessionKey() []byte { return s.sessionKey }

// SharedK returns the 32-byte encoding of the shared element K, or nil before
// Finish. Exposed for known-answer vector dumps; not needed in normal use.
func (s *State) SharedK() []byte { return s.sharedK }

// Vectors returns the fixed M, N points and the password scalar w (each as
// 32-byte canonical encodings) for the given code. It exists so vector tooling
// dumps the same constants both languages must agree on.
func Vectors(code string) (m, n, w []byte) {
	return pointM().Bytes(), pointN().Bytes(), PasswordScalar(code).Bytes()
}

// buildTranscript concatenates length-prefixed fields in the pinned order:
// idA, idB, S, T, K, w. Each field is prefixed with its 8-byte big-endian
// length. This byte layout is part of the wire contract.
func buildTranscript(sBytes, tBytes, kBytes, wBytes []byte) []byte {
	fields := [][]byte{
		[]byte(idA),
		[]byte(idB),
		sBytes,
		tBytes,
		kBytes,
		wBytes,
	}
	// Pre-size: 8-byte prefix per field plus payloads.
	total := 0
	for _, f := range fields {
		total += 8 + len(f)
	}
	out := make([]byte, 0, total)
	var prefix [8]byte
	for _, f := range fields {
		binary.BigEndian.PutUint64(prefix[:], uint64(len(f)))
		out = append(out, prefix[:]...)
		out = append(out, f...)
	}
	return out
}

// mac returns HMAC-SHA256(key, transcript).
func mac(key, transcript []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(transcript)
	return h.Sum(nil)
}
