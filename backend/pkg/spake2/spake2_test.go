package spake2

import (
	"bytes"
	"encoding/hex"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// seed64 expands a short hex string into a fixed 64-byte uniform seed.
func seed64(t *testing.T, h string) []byte {
	t.Helper()
	b, err := hex.DecodeString(h)
	require.NoError(t, err)
	require.Len(t, b, 64)
	return b
}

const (
	xSeedHex = "11111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222"
	ySeedHex = "33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444"
)

// TestValidRole pins the role enum.
func TestValidRole(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		role Role
		want bool
	}{
		{"A", RoleA, true},
		{"B", RoleB, true},
		{"unknown", Role("C"), false},
		{"empty", Role(""), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tt.want, ValidRole(tt.role))
		})
	}
}

// TestHandshakeAgrees runs a full A<->B exchange and asserts both sides derive
// the same session key and each verifies the other's confirmation MAC.
func TestHandshakeAgrees(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		code string
	}{
		{"short code", "4F2-9KQ"},
		{"digits", "1234-5678"},
		{"unicode", "café-déjà"},
		{"empty", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			a := NewA(tt.code)
			b := NewB(tt.code)

			tMsg, err := a.Start()
			require.NoError(t, err)
			sMsg, err := b.Start()
			require.NoError(t, err)
			require.Len(t, tMsg, MsgSize)
			require.Len(t, sMsg, MsgSize)

			keyA, confA, err := a.Finish(sMsg)
			require.NoError(t, err)
			keyB, confB, err := b.Finish(tMsg)
			require.NoError(t, err)

			require.Len(t, keyA, KeySize)
			assert.True(t, bytes.Equal(keyA, keyB), "session keys must match")
			require.Len(t, confA, ConfirmSize)

			require.NoError(t, a.Confirm(confB))
			require.NoError(t, b.Confirm(confA))
		})
	}
}

// TestKnownAnswer freezes the deterministic handshake outputs. These hex
// constants are the byte-for-byte contract the JS @noble implementation must
// reproduce (see frontend/test/spake2-interop.mjs). Changing them is a wire
// break.
func TestKnownAnswer(t *testing.T) {
	t.Parallel()

	const code = "4F2-9KQ"
	want := struct {
		m, n, w, tMsg, sMsg, k, sessionKey, confirmA, confirmB string
	}{
		m:          "7e27e1e928bff756b39a142ae4798b5acc7dd37da301954bbef437a10489490e",
		n:          "561646d4c8385aa7542c2f469cc3f845d224de401e837e50bf4f2a0306a91f41",
		w:          "0285360f806297cd126d50eb433442f667d66b47e96980b8a0faefcf409aa40f",
		tMsg:       "3c17ef4840bebb38c1a7a1b22d6b02270a04f31673ef04dc4b5d279cb8abf75d",
		sMsg:       "36d0bbc446b468eb811f003405245e5e718a987517548754281c58b5c7e37201",
		k:          "6294e735a93e8e9be9750ba7786822d49eef7a86318a3911ed74e53aeefd2e43",
		sessionKey: "f6eaa25f6d89648be506d9954c1f800680b916f7ae64a004a5023e5822a0c608",
		confirmA:   "83ba050691d09449063d773c015ec4de6ec41ddb574a9d9ec1b465d3388f1d3b",
		confirmB:   "f77f47026f9917f83e62bc02c384aca9a11ad8f74e79c2e8171923caec9abe6f",
	}

	m, n, w := Vectors(code)
	assert.Equal(t, want.m, hex.EncodeToString(m), "M")
	assert.Equal(t, want.n, hex.EncodeToString(n), "N")
	assert.Equal(t, want.w, hex.EncodeToString(w), "w")

	a := NewA(code)
	b := NewB(code)
	tMsg, err := a.StartDeterministic(seed64(t, xSeedHex))
	require.NoError(t, err)
	sMsg, err := b.StartDeterministic(seed64(t, ySeedHex))
	require.NoError(t, err)
	assert.Equal(t, want.tMsg, hex.EncodeToString(tMsg), "T")
	assert.Equal(t, want.sMsg, hex.EncodeToString(sMsg), "S")

	keyA, confA, err := a.Finish(sMsg)
	require.NoError(t, err)
	keyB, confB, err := b.Finish(tMsg)
	require.NoError(t, err)

	assert.Equal(t, want.k, hex.EncodeToString(a.SharedK()), "K (A)")
	assert.Equal(t, want.k, hex.EncodeToString(b.SharedK()), "K (B)")
	assert.Equal(t, want.sessionKey, hex.EncodeToString(keyA), "session key")
	assert.Equal(t, want.sessionKey, hex.EncodeToString(keyB), "session key B")
	assert.Equal(t, want.confirmA, hex.EncodeToString(confA), "confirm A")
	assert.Equal(t, want.confirmB, hex.EncodeToString(confB), "confirm B")
	require.NoError(t, a.Confirm(confB))
	require.NoError(t, b.Confirm(confA))
}

// TestWrongCodeFails asserts mismatched codes derive different keys and the
// confirmation MAC rejects the peer.
func TestWrongCodeFails(t *testing.T) {
	t.Parallel()

	a := NewA("4F2-9KQ")
	b := NewB("0000-000") // wrong code

	tMsg, err := a.Start()
	require.NoError(t, err)
	sMsg, err := b.Start()
	require.NoError(t, err)

	keyA, confA, err := a.Finish(sMsg)
	require.NoError(t, err)
	keyB, confB, err := b.Finish(tMsg)
	require.NoError(t, err)

	assert.False(t, bytes.Equal(keyA, keyB), "wrong code must not agree")
	assert.ErrorIs(t, a.Confirm(confB), ErrBadConfirm)
	assert.ErrorIs(t, b.Confirm(confA), ErrBadConfirm)
}

// TestBadPeerMsg rejects a non-canonical element.
func TestBadPeerMsg(t *testing.T) {
	t.Parallel()

	a := NewA("4F2-9KQ")
	_, err := a.Start()
	require.NoError(t, err)

	_, _, err = a.Finish(bytes.Repeat([]byte{0xff}, MsgSize))
	assert.ErrorIs(t, err, ErrBadPeerMsg)
}

// TestOrderGuards enforces Start -> Finish -> Confirm.
func TestOrderGuards(t *testing.T) {
	t.Parallel()

	a := NewA("4F2-9KQ")
	_, _, err := a.Finish(make([]byte, MsgSize))
	assert.ErrorIs(t, err, ErrNotStarted)
	assert.ErrorIs(t, a.Confirm(make([]byte, ConfirmSize)), ErrNotFinished)
}
