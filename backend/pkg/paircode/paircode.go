// Package paircode canonicalizes the human-typed pairing code and derives the
// rendezvous room id from it.
//
// The code is the entire SPAKE2 password (~39.6 bits). The room id is a one-way,
// domain-separated function of the code, so the content-blind relay learns
// nothing about the code from the room it forwards to (preimage resistance), and
// the phone can derive the same room from only the typed code — no QR, no link,
// nothing secret in any URL. Go and the JS twin (frontend/src/lib/codegen.ts)
// MUST compute Canonicalize and RoomFromCode byte-identically; the contract is
// pinned by frontend/test/spake2-interop.mjs. ref. docs/decisions/architecture.
package paircode

import (
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// Alphabet is the 31-symbol Crockford-ish set with the visually ambiguous
// characters (0/O, 1/I/L) removed for reliable manual entry — log2(31) ≈ 4.95
// bits per symbol. It is the single source of truth shared with the PWA.
const Alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

// Len is the number of code symbols. 8 × log2(31) ≈ 39.6 bits — the SPAKE2
// password's whole strength. Codes are displayed grouped as "XXXX-XXXX".
const Len = 8

// roomInfo domain-separates the room KDF from every SPAKE2/HKDF label already in
// use (spake2:M, spake2:N, agent, phone, session-key, kc:A, kc:B), so the room
// id can never reveal the code or coincide with transcript bytes. Frozen:
// changing it makes mismatched builds derive different rooms (silent no-pair).
const roomInfo = "ask-a-human:pair-room:v1"

// roomBytes truncates the room KDF output to 8 bytes -> 16 hex chars, matching
// the relay's frozen 16-hex room-id contract. 64 bits is a rendezvous tag only
// (never a secret); collisions at ~10k live rooms are ~1e-12.
const roomBytes = 8

// ErrInvalidCode is returned by Canonicalize when, after upper-casing and
// dropping separators, the input is not exactly Len symbols from Alphabet.
var ErrInvalidCode = errors.New("paircode: code must be 8 symbols from the pairing alphabet")

// Canonicalize folds a typed or displayed code to its canonical form: ASCII
// upper-case, then every character not in Alphabet (hyphen, spaces) dropped. The
// result must be exactly Len in-alphabet symbols. This SAME canonical string is
// fed to BOTH RoomFromCode and the SPAKE2 password on both sides — the hyphen
// and case are presentation only and never touch the crypto.
func Canonicalize(code string) (string, error) {
	var b strings.Builder
	b.Grow(Len)
	for _, r := range strings.ToUpper(code) {
		if strings.ContainsRune(Alphabet, r) {
			b.WriteRune(r)
		}
	}
	canon := b.String()
	if len(canon) != Len {
		return "", ErrInvalidCode
	}
	return canon, nil
}

// NewCode mints a fresh pairing code in DISPLAY form: Len symbols drawn
// uniformly from Alphabet, grouped at the midpoint as "XXXX-XXXX" (e.g.
// "4F2K-9QHR"). The code IS the SPAKE2 password (~39.6 bits), so symbols are
// drawn with rejection sampling to avoid the modulo bias that would favor the
// first 256%len(Alphabet) symbols. Feed the result through Canonicalize before
// using it as the password / room input — the hyphen and case are presentation
// only.
func NewCode() (string, error) {
	out := make([]byte, 0, Len+1)
	for i := 0; i < Len; i++ {
		if i == Len/2 {
			out = append(out, '-')
		}
		c, err := randSymbol()
		if err != nil {
			return "", err
		}
		out = append(out, c)
	}
	return string(out), nil
}

// randSymbol returns one uniform symbol from Alphabet. It rejects bytes in the
// biased tail (>= the largest multiple of len(Alphabet) below 256) so the
// modulo is unbiased; the expected reject rate is tiny (256 % 31 = 8/256).
func randSymbol() (byte, error) {
	const n = len(Alphabet)
	limit := byte(256 - (256 % n)) // 248 for n=31; bytes >= limit are biased.
	var b [1]byte
	for {
		if _, err := rand.Read(b[:]); err != nil {
			return 0, fmt.Errorf("paircode: code: %w", err)
		}
		if b[0] < limit {
			return Alphabet[int(b[0])%n], nil
		}
	}
}

// RoomFromCode derives the 16-hex rendezvous room id from a canonical code:
//
//	roomID = hex( HKDF-SHA256(ikm=canon, salt=nil, info=roomInfo)[:8] )
//
// canon must already be Canonicalize'd. The JS twin (codegen.roomFromCode)
// computes the identical value; ref. frontend/test/spake2-interop.mjs.
func RoomFromCode(canon string) (string, error) {
	okm, err := hkdf.Key(sha256.New, []byte(canon), nil, roomInfo, roomBytes)
	if err != nil {
		return "", fmt.Errorf("paircode: room kdf: %w", err)
	}
	return hex.EncodeToString(okm), nil
}
