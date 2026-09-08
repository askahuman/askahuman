package wire

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

func sampleRequest() Request {
	return Request{Kind: KindRequest, Protocol: Protocol, Room: "0123456789abcdef", ID: "id", Title: "Title", Summary: "Summary", Agent: "agent", Category: CategoryDeploy, Response: Response{Kind: ResponseText, Placeholder: "explain", MaxLen: 4096}, ExpiresInS: 300, DeadlineMS: 1800000000123}
}

func TestProtocolRequestBindsEveryAuthorizationField(t *testing.T) {
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, e)
	r := sampleRequest()
	sig, e := Sign(key, RequestSigningMessage(r))
	require.NoError(t, e)
	changes := map[string]func(*Request){"protocol": func(r *Request) { r.Protocol = 1 }, "room": func(r *Request) { r.Room = "fedcba9876543210" }, "id": func(r *Request) { r.ID += "x" }, "title": func(r *Request) { r.Title += "x" }, "summary": func(r *Request) { r.Summary += "x" }, "category": func(r *Request) { r.Category = CategoryCash }, "agent": func(r *Request) { r.Agent += "x" }, "kind": func(r *Request) { r.Response.Kind = ResponseYesNo }, "options": func(r *Request) { r.Response.Options = []string{"one", "two"} }, "placeholder": func(r *Request) { r.Response.Placeholder += "x" }, "max_len": func(r *Request) { r.Response.MaxLen-- }, "expires": func(r *Request) { r.ExpiresInS-- }, "deadline": func(r *Request) { r.DeadlineMS++ }}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			mutated := r
			change(&mutated)
			require.False(t, Verify(&key.PublicKey, RequestSigningMessage(mutated), sig))
		})
	}
	r2 := r
	r2.Response = Response{Kind: ResponseChoice, Options: []string{"ab", "c"}}
	r3 := r2
	r3.Response.Options = []string{"a", "bc"}
	require.NotEqual(t, RequestHash(r2), RequestHash(r3))
	r2.ID = "x\x00y"
	r2.Title = "z"
	r3.ID = "x"
	r3.Title = "y\x00z"
	require.NotEqual(t, RequestHash(r2), RequestHash(r3), "length prefixes prevent separator injection")
}

func TestProtocolStrictJSONRejectsAmbiguity(t *testing.T) {
	for _, raw := range []string{
		`{"id":"a","id":"b"}`, `{"id":"a","i\u0064":"b"}`, `{"ID":"a"}`, `{"id":null}`, `{"title":"\ud800"}`, `{"title":"\udfff"}`, `{"title":"\ud800x"}`, `{"title":"\ud800\u0041"}`,
		`{"protocol":2e0}`, `{"protocol":2.0}`, `{"deadline_ms":9007199254740992}`, `{"deadline_ms":-0}`, `{} {}`, "\ufeff{}",
		`{"response":{"options":` + strings.Repeat("[", 20) + `0` + strings.Repeat("]", 20) + `}}`,
	} {
		t.Run(raw, func(t *testing.T) { var r Request; require.Error(t, StrictDecode([]byte(raw), &r)) })
	}
	var r Request
	require.Error(t, StrictDecode([]byte("{\"title\":\"\xff\"}"), &r))
	require.NoError(t, StrictDecode([]byte(`{"title":"\ud83d\ude00","summary":"\\ud800"}`), &r))
	require.Equal(t, "😀", r.Title)
	require.Equal(t, `\ud800`, r.Summary)
	require.Error(t, StrictDecode(bytes.Repeat([]byte{' '}, MaxPlaintext+1), &r))
}

func TestProtocolSharedFieldAndEncodedBounds(t *testing.T) {
	r := sampleRequest()
	r.ID = strings.Repeat("😀", 256)
	r.Title = strings.Repeat("😀", 512)
	r.Agent = strings.Repeat("😀", 256)
	r.Summary = strings.Repeat("a", 4096)
	require.NoError(t, ValidateRequestInput(r), "Unicode scalar counts, not UTF-8 bytes")
	for name, mutate := range map[string]func(*Request){"id": func(r *Request) { r.ID += "x" }, "title": func(r *Request) { r.Title += "x" }, "summary": func(r *Request) { r.Summary += "x" }, "agent": func(r *Request) { r.Agent += "x" }, "utf8": func(r *Request) { r.Title = string([]byte{0xff}) }, "max_len": func(r *Request) { r.Response.MaxLen = 4097 }, "expiry": func(r *Request) { r.ExpiresInS = 86401 }, "aggregate": func(r *Request) { r.Summary = strings.Repeat("😀", 4096) }} {
		t.Run(name, func(t *testing.T) { copy := r; mutate(&copy); require.Error(t, ValidateRequestInput(copy)) })
	}
	for _, response := range []Response{{Kind: ResponseChoice}, {Kind: ResponseChoice, Options: []string{"x", "x"}}, {Kind: ResponseChoice, Options: []string{""}}, {Kind: ResponseYesNo, MaxLen: 1}, {Kind: ResponseText, Options: []string{}}, {Kind: ResponseText, MaxLen: -1}} {
		r := sampleRequest()
		r.Response = response
		require.Error(t, ValidateRequestInput(r))
	}
	r = sampleRequest()
	r.Summary = strings.Repeat("\x01", 3000)
	require.Less(t, utf8.RuneCountInString(r.Summary), 4096)
	require.Error(t, ValidateRequestInput(r), "escaped JSON overhead is included before pairing")
	r = sampleRequest()
	raw, e := EncodeMessage(r)
	require.NoError(t, e)
	require.Zero(t, len(raw)%256)
	require.LessOrEqual(t, len(raw), MaxPlaintext)
}

func TestProtocolDomainSeparationAndReceiptBinding(t *testing.T) {
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, e)
	d := Decision{Kind: KindDecision, Protocol: Protocol, Room: "0123456789abcdef", ID: "id", RequestHash: RequestHash(sampleRequest()), ResponseKind: ResponseYesNo, Result: Result{Approved: new(bool)}}
	sig, e := Sign(key, BoundDecisionSigningMessage(d))
	require.NoError(t, e)
	a := Ack{Kind: KindAck, Protocol: Protocol, Room: d.Room, ID: d.ID, RequestHash: d.RequestHash, DecisionHash: DecisionHash(d), Status: "accepted"}
	require.False(t, Verify(&key.PublicKey, AckSigningMessage(a), sig))
	a.Sig, e = Sign(key, AckSigningMessage(a))
	require.NoError(t, e)
	for _, change := range []func(*Ack){func(a *Ack) { a.Status = "expired" }, func(a *Ack) { a.DecisionHash = Hash([]byte("other result")) }, func(a *Ack) { a.RequestHash = Hash([]byte("other question")) }, func(a *Ack) { a.Room = "fedcba9876543210" }, func(a *Ack) { a.ID = "other" }, func(a *Ack) { a.Protocol = 1 }} {
		copy := a
		change(&copy)
		require.False(t, Verify(&key.PublicKey, AckSigningMessage(copy), a.Sig))
	}
	var encoded map[string]json.RawMessage
	raw, e := json.Marshal(d)
	require.NoError(t, e)
	require.NoError(t, json.Unmarshal(raw, &encoded))
	require.Equal(t, `{"approved":false}`, string(encoded["result"]))
	d.ResponseKind = ResponseText
	d.Result = Result{}
	require.NoError(t, ValidateDecision(d))
	require.NotEmpty(t, BoundDecisionSigningMessage(d))
	require.False(t, Verify(&key.PublicKey, BoundDecisionSigningMessage(d), sig))
}
