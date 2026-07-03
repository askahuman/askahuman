package wire

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestValidEnums(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		valid bool
		got   bool
	}{
		{"relay peer_joined", true, ValidRelaySignal(SignalPeerJoined)},
		{"relay undeliverable", true, ValidRelaySignal(SignalUndeliverable)},
		{"relay unknown", false, ValidRelaySignal(RelaySignal("nope"))},
		{"relay empty", false, ValidRelaySignal(RelaySignal(""))},

		{"msg request", true, ValidMessageKind(KindRequest)},
		{"msg push_sub", true, ValidMessageKind(KindPushSub)},
		{"msg vapid_key", true, ValidMessageKind(KindVAPIDKey)},
		{"msg device_key", true, ValidMessageKind(KindDeviceKey)},
		{"msg unknown", false, ValidMessageKind(MessageKind("nope"))},

		{"response yesno", true, ValidResponseKind(ResponseYesNo)},
		{"response choice", true, ValidResponseKind(ResponseChoice)},
		{"response text", true, ValidResponseKind(ResponseText)},
		{"response unknown", false, ValidResponseKind(ResponseKind("nope"))},

		{"category cash", true, ValidCategory(CategoryCash)},
		{"category other", true, ValidCategory(CategoryOther)},
		{"category unknown", false, ValidCategory(Category("freeform"))},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tt.valid, tt.got)
		})
	}
}

// TestFrameRoundTrip asserts the relay envelope serializes with the exact
// wire keys (_relay, box, confirm) and omits empty fields.
func TestFrameRoundTrip(t *testing.T) {
	t.Parallel()

	raw, err := json.Marshal(Frame{Box: "AAAA"})
	require.NoError(t, err)
	assert.JSONEq(t, `{"box":"AAAA"}`, string(raw))

	craw, err := json.Marshal(Frame{Confirm: "BBBB"})
	require.NoError(t, err)
	assert.JSONEq(t, `{"confirm":"BBBB"}`, string(craw))

	var got Frame
	require.NoError(t, json.Unmarshal([]byte(`{"_relay":"peer_joined"}`), &got))
	assert.Equal(t, SignalPeerJoined, got.Relay)
	assert.True(t, ValidRelaySignal(got.Relay))
}

// TestDecisionPadding proves the privacy fix: approve and decline of the same
// id produce identical seal-input lengths (no length leak via ciphertext), the
// length is a multiple of padBlock, and the padded plaintext still decodes.
func TestDecisionPadding(t *testing.T) {
	t.Parallel()

	yes, no := true, false
	id := "req_8f3a"
	approve, err := EncodeDecision(Decision{Kind: KindDecision, ID: id, Result: Result{Approved: &yes}})
	require.NoError(t, err)
	decline, err := EncodeDecision(Decision{Kind: KindDecision, ID: id, Result: Result{Approved: &no}})
	require.NoError(t, err)

	assert.Equal(t, len(approve), len(decline), "approve and decline must seal to equal length")
	assert.Zero(t, len(approve)%padBlock, "padded length must be a multiple of padBlock")

	var got Decision
	require.NoError(t, json.Unmarshal(approve, &got), "trailing-space padding must still decode")
	require.NotNil(t, got.Result.Approved)
	assert.True(t, *got.Result.Approved)
}

// TestRequestRoundTrip pins the application message keys against
// docs/plan.md section 5.
func TestRequestRoundTrip(t *testing.T) {
	t.Parallel()

	req := Request{
		Kind:       KindRequest,
		ID:         "req_8f3a",
		Title:      "Production deploy",
		Category:   CategoryDeploy,
		Summary:    "Deploy v2.3.1 to prod cluster?",
		Response:   Response{Kind: ResponseYesNo},
		ExpiresInS: 300,
	}
	raw, err := json.Marshal(req)
	require.NoError(t, err)

	var got Request
	require.NoError(t, json.Unmarshal(raw, &got))
	assert.Equal(t, req, got)
	assert.Contains(t, string(raw), `"expires_in_s":300`)
	assert.NotContains(t, string(raw), "placeholder")
}

// TestVAPIDKeyRoundTrip pins the vapid_key message keys and proves the padded
// encoder round-trips: only the public key crosses the wire, the padded length
// is a multiple of padBlock, and the padded plaintext still decodes.
func TestVAPIDKeyRoundTrip(t *testing.T) {
	t.Parallel()

	pub := "BJ_aG_x0kVpZ-2example-vapid-public-key"
	raw, err := EncodeVAPIDKey(pub)
	require.NoError(t, err)
	assert.Zero(t, len(raw)%padBlock, "padded length must be a multiple of padBlock")
	assert.Contains(t, string(raw), `"public_key":"`+pub+`"`)
	assert.NotContains(t, string(raw), "private")

	var got VAPIDKey
	require.NoError(t, json.Unmarshal(raw, &got), "trailing-space padding must still decode")
	assert.Equal(t, VAPIDKey{Kind: KindVAPIDKey, PublicKey: pub}, got)
}

// TestDecisionResults verifies each response kind's result field maps to
// the documented JSON shape.
func TestDecisionResults(t *testing.T) {
	t.Parallel()

	approved := true
	tests := []struct {
		name   string
		result Result
		want   string
	}{
		{"yesno", Result{Approved: &approved}, `{"approved":true}`},
		{"choice", Result{Choice: "Proceed"}, `{"choice":"Proceed"}`},
		{"text", Result{Text: "approve up to $500"}, `{"text":"approve up to $500"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			raw, err := json.Marshal(tt.result)
			require.NoError(t, err)
			assert.JSONEq(t, tt.want, string(raw))
		})
	}
}

// TestDeviceKeyRoundTrip pins the device_key message keys and proves the padded
// encoder round-trips: only the public key crosses the wire, the padded length
// is a multiple of padBlock, and the padded plaintext still decodes. Mirrors
// EncodeVAPIDKey/TestVAPIDKeyRoundTrip.
func TestDeviceKeyRoundTrip(t *testing.T) {
	t.Parallel()

	spki := "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-example-spki-base64"
	raw, err := EncodeDeviceKey(spki)
	require.NoError(t, err)
	assert.Zero(t, len(raw)%padBlock, "padded length must be a multiple of padBlock")
	assert.Contains(t, string(raw), `"public_key":"`+spki+`"`)
	assert.NotContains(t, string(raw), "private")

	var got DeviceKey
	require.NoError(t, json.Unmarshal(raw, &got), "trailing-space padding must still decode")
	assert.Equal(t, DeviceKey{Kind: KindDeviceKey, PublicKey: spki}, got)
}

// TestDecisionSigOmitEmpty proves a signed decision round-trips and an unsigned
// one omits the sig field entirely (byte-compatible with older agents/phones).
func TestDecisionSigOmitEmpty(t *testing.T) {
	t.Parallel()

	yes := true
	unsigned, err := json.Marshal(Decision{Kind: KindDecision, ID: "req_1", Result: Result{Approved: &yes}})
	require.NoError(t, err)
	assert.NotContains(t, string(unsigned), "sig", "an unsigned decision must not carry a sig key")

	signed, err := json.Marshal(Decision{Kind: KindDecision, ID: "req_1", Result: Result{Approved: &yes}, Sig: "AAAA"})
	require.NoError(t, err)
	assert.Contains(t, string(signed), `"sig":"AAAA"`)

	var got Decision
	require.NoError(t, json.Unmarshal(signed, &got))
	assert.Equal(t, "AAAA", got.Sig)
}

// TestDecisionSigningMessagePinsHex pins the canonical signed-message bytes for
// each result shape. The SAME hex is asserted in frontend/test/wire.test.ts so
// the Go and TS signers can never drift (cross-language byte contract, ADR 0021).
func TestDecisionSigningMessagePinsHex(t *testing.T) {
	t.Parallel()

	yes, no := true, false
	const room, id = "0123456789abcdef", "req_1"
	tests := []struct {
		name    string
		result  Result
		wantHex string
	}{
		{"yesno true", Result{Approved: &yes}, "6161683a6465636973696f6e3a76310030313233343536373839616263646566007265715f31007965736e6f3a31"},
		{"yesno false", Result{Approved: &no}, "6161683a6465636973696f6e3a76310030313233343536373839616263646566007265715f31007965736e6f3a30"},
		{"choice", Result{Choice: "Merge & retry"}, "6161683a6465636973696f6e3a76310030313233343536373839616263646566007265715f310063686f6963653a4d657267652026207265747279"},
		{"text", Result{Text: "up to $500"}, "6161683a6465636973696f6e3a76310030313233343536373839616263646566007265715f3100746578743a757020746f2024353030"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tt.wantHex, hex.EncodeToString(DecisionSigningMessage(room, id, tt.result)))
		})
	}
}

// TestDeviceSigInteropVector pins the WHOLE Go verify path against a vector the
// browser's WebCrypto produced once (see scratchpad gen-vector.mjs): a P-256 key
// signs DecisionSigningMessage("0123456789abcdef","req_1",{approved:true}). It
// asserts the canonical message hex, that the raw-64 r||s signature parses and
// verifies via ecdsa.Verify (NOT VerifyASN1 — the wire sig is raw, not DER), and
// that a one-bit tamper is rejected. This is the cross-language guard that Go and
// WebCrypto agree byte-for-byte on the signed message and the signature form.
func TestDeviceSigInteropVector(t *testing.T) {
	t.Parallel()

	// Generated once via Node 26 WebCrypto; checked in so the vector is stable.
	const (
		spkiB64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEji2hufrBrL4LJ+5BNzhLTe2lr9sGY0ZuUS/vP70w4bjBHet1ICbPvELtGqZakWlMwkAMCsLvZSOk2/jfHVh3zA=="
		sigB64  = "2aiYiJ27pyppH2DMEGdqAQyprbGWZBQsGcICv1tjbT01tN2O1Xetqzn1ff0HcEUp0LRz/AojWhdmgq4/PYNIRw=="
	)
	yes := true
	msg := DecisionSigningMessage("0123456789abcdef", "req_1", Result{Approved: &yes})
	require.Equal(t, "6161683a6465636973696f6e3a76310030313233343536373839616263646566007265715f31007965736e6f3a31", hex.EncodeToString(msg))

	der, err := base64.StdEncoding.DecodeString(spkiB64)
	require.NoError(t, err)
	pubAny, err := x509.ParsePKIXPublicKey(der)
	require.NoError(t, err)
	pub, ok := pubAny.(*ecdsa.PublicKey)
	require.True(t, ok, "the vector must decode to an ECDSA public key")
	require.Equal(t, elliptic.P256(), pub.Curve)

	sig, err := base64.StdEncoding.DecodeString(sigB64)
	require.NoError(t, err)
	require.Len(t, sig, 64, "WebCrypto emits raw IEEE-P1363 r||s = 64 bytes for P-256")
	digest := sha256.Sum256(msg)
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	assert.True(t, ecdsa.Verify(pub, digest[:], r, s), "the browser-signed vector must verify in Go")

	// A one-bit tamper on r must fail to verify.
	tampered := make([]byte, 64)
	copy(tampered, sig)
	tampered[0] ^= 0x01
	rt := new(big.Int).SetBytes(tampered[:32])
	st := new(big.Int).SetBytes(tampered[32:])
	assert.False(t, ecdsa.Verify(pub, digest[:], rt, st), "a tampered signature must not verify")
}
