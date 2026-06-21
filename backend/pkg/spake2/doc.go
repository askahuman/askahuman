// Package spake2 implements the SPAKE2 password-authenticated key
// exchange over ristretto255, used for wormhole-style pairing: both peers
// enter the same short code and derive an identical 32-byte session key,
// while a network/relay attacker gets only one online guess per attempt
// (no offline attack, no pubkey-swap MITM).
//
// The Go side must interoperate byte-for-byte with the JS PWA's
// @noble/curves implementation: identical group (ristretto255), M/N
// seed points, transcript hash, and HKDF derivation. See
// docs/decisions/architecture/0002_spake2_ristretto255_secretbox.md and
// docs/plan.md section 4.
//
// The group arithmetic comes from github.com/gtank/ristretto255 (RFC 9496);
// the SPAKE2 protocol logic is ours. Use NewA (agent) or NewB (phone), then
// call Start -> Finish -> Confirm in order. The exact construction is frozen
// in cmd/spake2vectors and asserted byte-for-byte against the JS @noble
// implementation by frontend/test/spake2-interop.mjs.
package spake2
