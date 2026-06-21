package sealedbox

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"

	"golang.org/x/crypto/nacl/secretbox"
)

// KeySize is the secretbox key length in bytes (XSalsa20-Poly1305).
const KeySize = 32

// NonceSize is the secretbox nonce length in bytes.
const NonceSize = 24

// ErrKeySize is returned when a key is not exactly KeySize bytes.
var ErrKeySize = errors.New("sealedbox: key must be 32 bytes")

// ErrShortPayload is returned when a payload is too short to hold a nonce.
var ErrShortPayload = errors.New("sealedbox: payload shorter than nonce")

// ErrOpen is returned when authentication fails on Open. A decision is
// accepted only when Open succeeds; a failure is never trusted. See
// docs/plan.md section 8.
var ErrOpen = errors.New("sealedbox: open: authentication failed")

// Seal encrypts plaintext under key with a fresh random 24-byte nonce and
// returns base64(nonce || secretbox(plaintext)). The wire format is
// identical to the JS TweetNaCl counterpart in the PWA.
func Seal(key, plaintext []byte) (string, error) {
	if len(key) != KeySize {
		return "", ErrKeySize
	}
	var nonce [NonceSize]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", fmt.Errorf("sealedbox: nonce: %w", err)
	}
	var k [KeySize]byte
	copy(k[:], key)
	out := secretbox.Seal(nonce[:], plaintext, &nonce, &k)
	return base64.StdEncoding.EncodeToString(out), nil
}

// Open base64-decodes payload, splits the leading 24-byte nonce, and
// authenticates+decrypts the remainder under key. It returns ErrOpen on any
// authentication failure so callers never treat a bad frame as valid.
func Open(key []byte, payload string) ([]byte, error) {
	if len(key) != KeySize {
		return nil, ErrKeySize
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return nil, fmt.Errorf("sealedbox: base64: %w", err)
	}
	if len(raw) < NonceSize {
		return nil, ErrShortPayload
	}
	var nonce [NonceSize]byte
	copy(nonce[:], raw[:NonceSize])
	var k [KeySize]byte
	copy(k[:], key)
	out, ok := secretbox.Open(nil, raw[NonceSize:], &nonce, &k)
	if !ok {
		return nil, ErrOpen
	}
	return out, nil
}

// SealWithNonce is Seal with a caller-supplied nonce. It exists only for
// deterministic known-answer vectors and tests; production code must use
// Seal so every message gets a fresh random nonce.
func SealWithNonce(key, nonce, plaintext []byte) (string, error) {
	if len(key) != KeySize {
		return "", ErrKeySize
	}
	if len(nonce) != NonceSize {
		return "", fmt.Errorf("sealedbox: nonce must be %d bytes", NonceSize)
	}
	var n [NonceSize]byte
	copy(n[:], nonce)
	var k [KeySize]byte
	copy(k[:], key)
	out := secretbox.Seal(n[:], plaintext, &n, &k)
	return base64.StdEncoding.EncodeToString(out), nil
}
