// protocolvectors exercises v2 signing and identity-bound PAKE across Go/JS.
// The fixed private keys below are public TEST VECTORS, never session identities.
package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"

	"github.com/askahuman/askahuman/backend/pkg/spake2"
	"github.com/askahuman/askahuman/backend/pkg/wire"
)

func key(n int64) *ecdsa.PrivateKey {
	d := big.NewInt(n)
	x, y := elliptic.P256().ScalarBaseMult(d.Bytes())
	return &ecdsa.PrivateKey{PublicKey: ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, D: d}
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	agent, phone := key(7), key(11)
	agentSPKI, e := wire.PublicSigner(agent)
	must(e)
	phoneSPKI, e := wire.PublicSigner(phone)
	must(e)
	req := wire.Request{Kind: wire.KindRequest, Protocol: wire.Protocol, RequestSeq: 42, Room: "0123456789abcdef", ID: "req_🧭\x00:1", Title: "Ship 🧭?", Category: wire.CategoryDeploy, Summary: "a|b\ne\u0301 😀 \u2028", Agent: "工具", Response: wire.Response{Kind: wire.ResponseChoice, Options: []string{"No", "Yes", "Maybe 🧭"}}, ExpiresInS: 300, DeadlineMS: 1800000000123}
	req.Sig, e = wire.Sign(agent, wire.RequestSigningMessage(req))
	must(e)
	dec := wire.Decision{Kind: wire.KindDecision, Protocol: wire.Protocol, Room: req.Room, ID: req.ID, RequestHash: wire.RequestHash(req), ResponseKind: req.Response.Kind, Result: wire.Result{Choice: "Maybe 🧭"}}
	dec.Sig, e = wire.Sign(phone, wire.BoundDecisionSigningMessage(dec))
	must(e)
	ack := wire.Ack{Kind: wire.KindAck, Protocol: wire.Protocol, Room: req.Room, ID: req.ID, RequestHash: dec.RequestHash, DecisionHash: wire.DecisionHash(dec), Status: "accepted"}
	ack.Sig, e = wire.Sign(agent, wire.AckSigningMessage(ack))
	must(e)
	push := wire.PushSub{Kind: wire.KindPushSub, Protocol: wire.Protocol, PushSeq: 27, Room: req.Room, Subscription: wire.PushSubscription{Endpoint: "https://web.push.apple.com/vector", Keys: wire.PushKeys{P256dh: "p256dh", Auth: "auth"}}}
	push.Sig, e = wire.Sign(phone, wire.PushSigningMessage(push))
	must(e)
	vapid := wire.VAPIDKey{Kind: wire.KindVAPIDKey, Protocol: wire.Protocol, Room: req.Room, PublicKey: "public-vector-key"}
	vapid.Sig, e = wire.Sign(agent, wire.VAPIDSigningMessage(vapid))
	must(e)
	msgs := map[string][]byte{"request": wire.RequestSigningMessage(req), "decision": wire.BoundDecisionSigningMessage(dec), "ack": wire.AckSigningMessage(ack), "push": wire.PushSigningMessage(push), "vapid": wire.VAPIDSigningMessage(vapid), "pair": wire.PairBinding(req.Room, agentSPKI, phoneSPKI)}
	if len(os.Args) > 1 && os.Args[1] == "--verify" {
		var input struct {
			Signer     string            `json:"signer"`
			Signatures map[string]string `json:"signatures"`
		}
		must(json.NewDecoder(os.Stdin).Decode(&input))
		pub, e := wire.ParseSigner(input.Signer)
		must(e)
		for name, msg := range msgs {
			if !wire.Verify(pub, msg, input.Signatures[name]) {
				fmt.Fprintln(os.Stderr, "signature failed:", name)
				os.Exit(1)
			}
		}
		fmt.Println("Go verified all JS signatures")
		return
	}
	a, b := spake2.NewA("0123456789"), spake2.NewB("0123456789")
	ap, e := a.StartDeterministic(bytes.Repeat([]byte{17}, 64))
	must(e)
	bp, e := b.StartDeterministic(bytes.Repeat([]byte{34}, 64))
	must(e)
	ak, ac, e := a.FinishWithContext(bp, msgs["pair"])
	must(e)
	bk, bc, e := b.FinishWithContext(ap, msgs["pair"])
	must(e)
	must(a.Confirm(bc))
	must(b.Confirm(ac))
	if !bytes.Equal(ak, bk) {
		panic("key mismatch")
	}
	encoded := map[string]string{}
	for name, msg := range msgs {
		encoded[name] = hex.EncodeToString(msg)
	}
	out := map[string]any{"agent_signer": agentSPKI, "phone_signer": phoneSPKI, "request": req, "decision": dec, "ack": ack, "push": push, "vapid": vapid, "messages": encoded, "session_key": hex.EncodeToString(ak), "confirm_a": hex.EncodeToString(ac), "confirm_b": hex.EncodeToString(bc)}
	must(json.NewEncoder(os.Stdout).Encode(out))
}
