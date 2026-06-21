// Package sealedbox seals and opens application messages with the
// symmetric session key derived at pairing. Post-pairing traffic uses
// NaCl secretbox (XSalsa20-Poly1305): payload = base64(nonce ||
// secretbox(plaintext)) with a fresh random 24-byte nonce per message.
//
// This is the only party (with its JS TweetNaCl counterpart in the PWA)
// that ever reads plaintext; the relay forwards opaque base64 and stays
// content-blind. A decision is accepted only when Open succeeds — a
// failure is never treated as "approved". See
// docs/decisions/architecture/0002_spake2_ristretto255_secretbox.md and
// docs/plan.md sections 3 and 8.
package sealedbox
