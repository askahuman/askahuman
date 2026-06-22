// Command spake2vectors prints a deterministic SPAKE2-over-ristretto255
// handshake and a secretbox sample as JSON, the frozen interop fixture the JS
// @noble implementation is asserted against. With --open it opens a
// JS-sealed secretbox payload under the same deterministic session key,
// proving the JS -> Go direction of the round trip.
//
// All scalars/points/keys are hex; secretbox payloads are base64. The fixed
// code and the two 64-byte ephemeral seeds (xSeed, ySeed) below are the
// inputs the JS side feeds to reproduce identical outputs.
package main

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/askahuman/askahuman/backend/pkg/paircode"
	"github.com/askahuman/askahuman/backend/pkg/sealedbox"
	"github.com/askahuman/askahuman/backend/pkg/spake2"
)

// Frozen deterministic inputs. The JS interop harness hard-codes the same
// values; do not change without regenerating the JS expectations.
const (
	fixedCode = "4F2-9KQ"
	// fixedRoomCode pins the code-only room derivation (paircode). It is given in
	// lowercase WITH a hyphen on purpose so the interop check also exercises
	// Canonicalize (uppercase + strip separators) Go<->JS, not just RoomFromCode.
	fixedRoomCode = "4f2k-9qhr"
	// xSeed/ySeed are 64-byte uniform seeds for A's x and B's y, reduced mod l.
	xSeedHex = "11111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222"
	ySeedHex = "33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444"
	// secretbox sample: a fixed 24-byte nonce + a fixed plaintext, sealed under
	// the derived session key. JS must recover the same ciphertext.
	sampleNonceHex  = "0102030405060708090a0b0c0d0e0f101112131415161718"
	samplePlaintext = `{"kind":"decision","id":"req_8f3a","result":{"approved":true}}`
)

type vectors struct {
	Code       string `json:"code"`
	M          string `json:"M"`
	N          string `json:"N"`
	W          string `json:"w"`
	XSeed      string `json:"x_seed"`
	YSeed      string `json:"y_seed"`
	T          string `json:"T"`
	S          string `json:"S"`
	K          string `json:"K"`
	SessionKey string `json:"session_key"`
	ConfirmA   string `json:"confirm_a"`
	ConfirmB   string `json:"confirm_b"`
	Secretbox  sample `json:"secretbox"`
	// Code-only pairing room derivation (paircode): RoomCode is the raw typed
	// form, RoomCanon its canonical form, RoomID = RoomFromCode(RoomCanon).
	RoomCode  string `json:"room_code"`
	RoomCanon string `json:"room_canon"`
	RoomID    string `json:"room_id"`
}

type sample struct {
	Key        string `json:"key"`
	Nonce      string `json:"nonce"`
	Plaintext  string `json:"plaintext"`
	Ciphertext string `json:"ciphertext"` // base64(nonce || box)
}

func main() {
	open := flag.Bool("open", false, "open a JS-sealed --payload under the deterministic session key (JS -> Go check)")
	payload := flag.String("payload", "", "base64(nonce||ciphertext) to open with --open")
	flag.Parse()

	if err := run(*open, *payload); err != nil {
		fmt.Fprintln(os.Stderr, "spake2vectors:", err)
		os.Exit(1)
	}
}

func run(open bool, payload string) error {
	sessionKey, v, err := handshake()
	if err != nil {
		return err
	}
	if open {
		if payload == "" {
			return fmt.Errorf("--open requires --payload")
		}
		pt, err := sealedbox.Open(sessionKey, payload)
		if err != nil {
			return fmt.Errorf("open: %w", err)
		}
		fmt.Print(string(pt))
		return nil
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// handshake runs the full deterministic A<->B exchange and returns the shared
// session key plus the JSON vectors.
func handshake() ([]byte, vectors, error) {
	xSeed, err := hex.DecodeString(xSeedHex)
	if err != nil {
		return nil, vectors{}, fmt.Errorf("x_seed: %w", err)
	}
	ySeed, err := hex.DecodeString(ySeedHex)
	if err != nil {
		return nil, vectors{}, fmt.Errorf("y_seed: %w", err)
	}

	a := spake2.NewA(fixedCode)
	b := spake2.NewB(fixedCode)

	tMsg, err := a.StartDeterministic(xSeed) // T
	if err != nil {
		return nil, vectors{}, fmt.Errorf("start A: %w", err)
	}
	sMsg, err := b.StartDeterministic(ySeed) // S
	if err != nil {
		return nil, vectors{}, fmt.Errorf("start B: %w", err)
	}

	keyA, confirmA, err := a.Finish(sMsg)
	if err != nil {
		return nil, vectors{}, fmt.Errorf("finish A: %w", err)
	}
	keyB, confirmB, err := b.Finish(tMsg)
	if err != nil {
		return nil, vectors{}, fmt.Errorf("finish B: %w", err)
	}

	if err := a.Confirm(confirmB); err != nil {
		return nil, vectors{}, fmt.Errorf("A confirm B: %w", err)
	}
	if err := b.Confirm(confirmA); err != nil {
		return nil, vectors{}, fmt.Errorf("B confirm A: %w", err)
	}
	if hex.EncodeToString(keyA) != hex.EncodeToString(keyB) {
		return nil, vectors{}, fmt.Errorf("session keys diverge: A=%x B=%x", keyA, keyB)
	}

	nonce, err := hex.DecodeString(sampleNonceHex)
	if err != nil {
		return nil, vectors{}, fmt.Errorf("nonce: %w", err)
	}
	ciphertext, err := sealedbox.SealWithNonce(keyA, nonce, []byte(samplePlaintext))
	if err != nil {
		return nil, vectors{}, fmt.Errorf("seal sample: %w", err)
	}

	roomCanon, err := paircode.Canonicalize(fixedRoomCode)
	if err != nil {
		return nil, vectors{}, fmt.Errorf("room canonicalize: %w", err)
	}
	roomID, err := paircode.RoomFromCode(roomCanon)
	if err != nil {
		return nil, vectors{}, fmt.Errorf("room from code: %w", err)
	}

	m, n, w := spake2.Vectors(fixedCode)
	v := vectors{
		Code:       fixedCode,
		M:          hex.EncodeToString(m),
		N:          hex.EncodeToString(n),
		W:          hex.EncodeToString(w),
		XSeed:      xSeedHex,
		YSeed:      ySeedHex,
		T:          hex.EncodeToString(tMsg),
		S:          hex.EncodeToString(sMsg),
		K:          hex.EncodeToString(a.SharedK()),
		SessionKey: hex.EncodeToString(keyA),
		ConfirmA:   hex.EncodeToString(confirmA),
		ConfirmB:   hex.EncodeToString(confirmB),
		Secretbox: sample{
			Key:        hex.EncodeToString(keyA),
			Nonce:      sampleNonceHex,
			Plaintext:  samplePlaintext,
			Ciphertext: ciphertext,
		},
		RoomCode:  fixedRoomCode,
		RoomCanon: roomCanon,
		RoomID:    roomID,
	}
	return keyA, v, nil
}
