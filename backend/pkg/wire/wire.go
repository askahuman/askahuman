// Package wire defines the JSON frames exchanged with the relay and the
// application messages that live, encrypted, inside a sealed box.
//
// Two layers travel on the same WebSocket:
//
//   - Relay frames (Frame): the relay generates `_relay` signals and
//     forwards every other field verbatim. It never decodes Box/Sealed.
//   - Application messages (Request, Decision, PushSub): plaintext that
//     lives inside Frame.Box and is only ever readable by the two paired
//     peers. The relay is content-blind. See docs/plan.md section 5.
package wire

import (
	"bytes"
	"encoding/json"
)

// padBlock is the fixed block size (bytes) the app plaintext is padded up to
// before sealing. A yes/no decision otherwise leaks via ciphertext length
// (approve vs decline differ by a few bytes); padding to a fixed multiple
// hides the distinction. Padding is trailing ASCII spaces, which both
// encoding/json and JSON.parse ignore, so decoders need no change. The JS
// side (frontend/src/lib/wire.ts pad) MUST use this same constant.
const padBlock = 256

// pad right-pads b with ASCII spaces (0x20) up to the next multiple of
// padBlock. JSON parsers ignore trailing whitespace, so a padded plaintext
// round-trips identically. An already block-aligned input is padded by a
// full block so the unpadded length is never recoverable from the total.
func pad(b []byte) []byte {
	n := padBlock - (len(b) % padBlock)
	return append(b, bytes.Repeat([]byte{' '}, n)...)
}

// EncodeRequest JSON-encodes r and pads the plaintext to a fixed block so the
// request body length does not leak through the sealed box. Seal the result.
func EncodeRequest(r Request) ([]byte, error) {
	raw, err := json.Marshal(r)
	if err != nil {
		return nil, err
	}
	return pad(raw), nil
}

// EncodeDecision JSON-encodes d and pads the plaintext to a fixed block so
// approve vs decline (and all decisions) seal to the same length, hiding the
// answer from the relay via ciphertext-length analysis. Seal the result.
func EncodeDecision(d Decision) ([]byte, error) {
	raw, err := json.Marshal(d)
	if err != nil {
		return nil, err
	}
	return pad(raw), nil
}

// EncodeVAPIDKey JSON-encodes the agent's VAPID public key and pads the
// plaintext to a fixed block, matching the other sealed encoders. Only the
// public key crosses the wire; the private key never leaves the agent. Seal
// the result.
func EncodeVAPIDKey(pub string) ([]byte, error) {
	raw, err := json.Marshal(VAPIDKey{Kind: KindVAPIDKey, PublicKey: pub})
	if err != nil {
		return nil, err
	}
	return pad(raw), nil
}

// RelaySignal is a relay-injected control value carried in Frame.Relay.
// The relay is the only party that may set it; clients never send it.
type RelaySignal string

// Relay signals injected by the relay (see docs/plan.md section 5).
const (
	// SignalPeerJoined means the room's other peer connected.
	SignalPeerJoined RelaySignal = "peer_joined"
	// SignalPeerLeft means the room's other peer disconnected.
	SignalPeerLeft RelaySignal = "peer_left"
	// SignalUndeliverable means a frame could not be delivered because the
	// peer is absent; the sender must retry. See docs/plan.md section 8.
	SignalUndeliverable RelaySignal = "undeliverable"
)

// ValidRelaySignal reports whether s is a known relay signal.
func ValidRelaySignal(s RelaySignal) bool {
	switch s {
	case SignalPeerJoined, SignalPeerLeft, SignalUndeliverable:
		return true
	default:
		return false
	}
}

// Frame is the JSON envelope on the WebSocket. Exactly one field is set
// per frame. The relay reads only Relay; it forwards Pake, Confirm, and Box
// verbatim without inspecting their contents.
type Frame struct {
	// Relay is a relay-injected control signal; clients never set it.
	Relay RelaySignal `json:"_relay,omitempty"`
	// Pake carries a base64 SPAKE2 Start/Finish message during pairing.
	Pake string `json:"pake,omitempty"`
	// Confirm carries the base64 SPAKE2 key-confirmation MAC during pairing.
	Confirm string `json:"confirm,omitempty"`
	// Box carries base64(nonce || ciphertext) for all post-pairing traffic.
	Box string `json:"box,omitempty"`
}

// MessageKind tags an application message inside a Box.
type MessageKind string

// Application message kinds (see docs/plan.md section 5).
const (
	// KindRequest is an approval request from agent to phone.
	KindRequest MessageKind = "request"
	// KindDecision is the human's answer from phone to agent.
	KindDecision MessageKind = "decision"
	// KindPushSub delivers the phone's sealed push subscription to the agent.
	KindPushSub MessageKind = "push_sub"
	// KindVAPIDKey delivers the agent's VAPID public key to the phone so it
	// subscribes with exactly the key the agent signs wake-up pushes with.
	KindVAPIDKey MessageKind = "vapid_key"
)

// ValidMessageKind reports whether k is a known application message kind.
func ValidMessageKind(k MessageKind) bool {
	switch k {
	case KindRequest, KindDecision, KindPushSub, KindVAPIDKey:
		return true
	default:
		return false
	}
}

// ResponseKind is the answer shape a request asks the human for.
type ResponseKind string

// Response kinds the phone can render (see docs/plan.md section 5).
const (
	// ResponseYesNo is a swipe approve/decline card.
	ResponseYesNo ResponseKind = "yesno"
	// ResponseChoice is a set of tappable options.
	ResponseChoice ResponseKind = "choice"
	// ResponseText is a short free-text input.
	ResponseText ResponseKind = "text"
)

// ValidResponseKind reports whether k is a known response kind.
func ValidResponseKind(k ResponseKind) bool {
	switch k {
	case ResponseYesNo, ResponseChoice, ResponseText:
		return true
	default:
		return false
	}
}

// Category is the badge shown on a request card. It is free-form on the
// wire; these are the known values that get a dedicated color.
type Category string

// Known request categories (see docs/plan.md section 5).
const (
	// CategoryCash flags money-moving requests.
	CategoryCash Category = "cash"
	// CategoryDeploy flags deployment/release requests.
	CategoryDeploy Category = "deploy"
	// CategoryData flags data-mutating requests.
	CategoryData Category = "data"
	// CategoryAccess flags access/permission requests.
	CategoryAccess Category = "access"
	// CategoryOther is the catch-all badge.
	CategoryOther Category = "other"
)

// ValidCategory reports whether c is a known category. Categories are
// free-form on the wire; an unknown value is still rendered (as "other").
func ValidCategory(c Category) bool {
	switch c {
	case CategoryCash, CategoryDeploy, CategoryData, CategoryAccess, CategoryOther:
		return true
	default:
		return false
	}
}

// Response describes the answer shape requested from the human.
type Response struct {
	// Kind selects the UI: yesno, choice, or text.
	Kind ResponseKind `json:"kind"`
	// Options are the choices for ResponseChoice.
	Options []string `json:"options,omitempty"`
	// Placeholder hints the input for ResponseText.
	Placeholder string `json:"placeholder,omitempty"`
	// MaxLen caps the input length for ResponseText.
	MaxLen int `json:"max_len,omitempty"`
}

// Request is an approval request sent agent -> phone, sealed inside a Box.
type Request struct {
	// Kind is always KindRequest.
	Kind MessageKind `json:"kind"`
	// ID uniquely identifies the request; the phone de-dupes by it.
	ID string `json:"id"`
	// Title is the card's window title.
	Title string `json:"title"`
	// Category is the badge color (see Category).
	Category Category `json:"category,omitempty"`
	// Summary is the human-readable question body.
	Summary string `json:"summary"`
	// Agent optionally names who is asking (e.g. "cursor @ workstation").
	Agent string `json:"agent,omitempty"`
	// Response is the answer shape requested.
	Response Response `json:"response"`
	// ExpiresInS is the optional countdown in seconds.
	ExpiresInS int `json:"expires_in_s,omitempty"`
}

// Result is the human's answer; exactly one field is set per Decision,
// matching the Request's Response.Kind.
type Result struct {
	// Approved is set for ResponseYesNo.
	Approved *bool `json:"approved,omitempty"`
	// Choice is set for ResponseChoice.
	Choice string `json:"choice,omitempty"`
	// Text is set for ResponseText.
	Text string `json:"text,omitempty"`
}

// Decision is the human's answer sent phone -> agent, sealed inside a Box.
type Decision struct {
	// Kind is always KindDecision.
	Kind MessageKind `json:"kind"`
	// ID echoes the Request.ID being answered.
	ID string `json:"id"`
	// Result carries the answer matching the request's response kind.
	Result Result `json:"result"`
}

// PushSubscription is a Web Push subscription (RFC 8030/8291). The phone
// sends it sealed so the relay never learns the endpoint.
type PushSubscription struct {
	// Endpoint is the push service URL.
	Endpoint string `json:"endpoint"`
	// Keys holds the p256dh and auth secrets for RFC 8291 encryption.
	Keys PushKeys `json:"keys"`
}

// PushKeys are the client keys used to encrypt Web Push payloads.
type PushKeys struct {
	// P256dh is the client's public key (base64url, uncompressed P-256).
	P256dh string `json:"p256dh"`
	// Auth is the client's auth secret (base64url, 16 bytes).
	Auth string `json:"auth"`
}

// PushSub delivers the phone's PushSubscription to the agent, sealed
// inside a Box so the relay never sees the endpoint.
type PushSub struct {
	// Kind is always KindPushSub.
	Kind MessageKind `json:"kind"`
	// Subscription is the sealed Web Push subscription.
	Subscription PushSubscription `json:"subscription"`
}

// VAPIDKey delivers the agent's VAPID public key to the phone, sealed
// inside a Box so the phone subscribes for Web Push with exactly the key
// the agent signs wake-up pushes with (signer == subscribe-key). Only the
// PUBLIC key ever crosses the wire; the private key never leaves the agent.
type VAPIDKey struct {
	// Kind is always KindVAPIDKey.
	Kind MessageKind `json:"kind"`
	// PublicKey is the agent's VAPID public key (base64url, uncompressed P-256).
	PublicKey string `json:"public_key"`
}
