package sealedbox

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func key32(t *testing.T) []byte {
	t.Helper()
	k, err := hex.DecodeString("f6eaa25f6d89648be506d9954c1f800680b916f7ae64a004a5023e5822a0c608")
	require.NoError(t, err)
	return k
}

// TestSealOpenRoundTrip seals then opens under the same key.
func TestSealOpenRoundTrip(t *testing.T) {
	t.Parallel()

	key := key32(t)
	plaintext := []byte(`{"kind":"decision","id":"req_8f3a","result":{"approved":true}}`)

	payload, err := Seal(key, plaintext)
	require.NoError(t, err)

	got, err := Open(key, payload)
	require.NoError(t, err)
	assert.True(t, bytes.Equal(plaintext, got))
}

// TestKnownAnswer freezes the deterministic ciphertext the JS TweetNaCl side
// must reproduce (fixed key + fixed nonce). See cmd/spake2vectors.
func TestKnownAnswer(t *testing.T) {
	t.Parallel()

	key := key32(t)
	nonce, err := hex.DecodeString("0102030405060708090a0b0c0d0e0f101112131415161718")
	require.NoError(t, err)
	plaintext := []byte(`{"kind":"decision","id":"req_8f3a","result":{"approved":true}}`)

	const want = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYrhluzQGUqA3FIjRDmVwI3Q7ZMchF7d+dpjMauMFc7lGvS3LCSDOzYZgSQx6TpP0JuMEpXHMgayMtaOBDc0By3AulsFvmr4doQfKDPu4K"

	payload, err := SealWithNonce(key, nonce, plaintext)
	require.NoError(t, err)
	assert.Equal(t, want, payload)

	got, err := Open(key, payload)
	require.NoError(t, err)
	assert.Equal(t, plaintext, got)
}

// TestOpenRejects covers tamper, wrong key, short payload, bad base64.
func TestOpenRejects(t *testing.T) {
	t.Parallel()

	key := key32(t)
	payload, err := Seal(key, []byte("hello"))
	require.NoError(t, err)

	t.Run("tampered", func(t *testing.T) {
		t.Parallel()
		raw, derr := base64.StdEncoding.DecodeString(payload)
		require.NoError(t, derr)
		raw[len(raw)-1] ^= 0x01
		_, oerr := Open(key, base64.StdEncoding.EncodeToString(raw))
		assert.ErrorIs(t, oerr, ErrOpen)
	})

	t.Run("wrong key", func(t *testing.T) {
		t.Parallel()
		wrong := make([]byte, KeySize)
		_, oerr := Open(wrong, payload)
		assert.ErrorIs(t, oerr, ErrOpen)
	})

	t.Run("short payload", func(t *testing.T) {
		t.Parallel()
		short := base64.StdEncoding.EncodeToString(make([]byte, NonceSize-1))
		_, oerr := Open(key, short)
		assert.ErrorIs(t, oerr, ErrShortPayload)
	})

	t.Run("bad base64", func(t *testing.T) {
		t.Parallel()
		_, oerr := Open(key, "!!!not base64!!!")
		assert.Error(t, oerr)
	})
}

// TestKeySize rejects wrong-length keys on both Seal and Open.
func TestKeySize(t *testing.T) {
	t.Parallel()

	_, err := Seal(make([]byte, 31), nil)
	assert.ErrorIs(t, err, ErrKeySize)
	_, err = Open(make([]byte, 33), "AAAA")
	assert.ErrorIs(t, err, ErrKeySize)
}
