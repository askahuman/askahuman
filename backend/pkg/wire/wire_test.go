package wire

import (
	"encoding/json"
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
