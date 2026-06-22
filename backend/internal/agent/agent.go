// Package agent runs next to an AI agent (Cursor/Claude/Codex) as a stdio
// MCP server. It owns the session key and VAPID keypair (RAM only), runs
// SPAKE2 pairing, seals/opens application messages, sends Web Push to wake
// the phone, and re-announces a pending request until it receives an
// authenticated decision or times out. A failure is never returned as
// "approved".
//
// See docs/decisions/architecture/0005_relay_ramonly_agent_retries.md and
// docs/plan.md sections 8 and 10.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/askahuman/askahuman/backend/pkg/paircode"
	"github.com/askahuman/askahuman/backend/pkg/sealedbox"
	"github.com/askahuman/askahuman/backend/pkg/wire"
)

// Default relay endpoint for local dev.
const defaultRelayURL = "ws://127.0.0.1:8080/ws"

// Retry/backoff bounds for the Ask re-announce loop (see plan section 8).
const (
	baseBackoff = 500 * time.Millisecond
	maxBackoff  = 5 * time.Second
)

// vapidSubject identifies the push sender in the VAPID JWT (RFC 8292). The
// relay never sees it; the push service requires a mailto/URL subject.
const vapidSubject = "mailto:ask-a-human@localhost"

// ErrTimeout is returned when no authenticated decision arrives before the
// request's deadline. It is never substituted with an "approved" result.
var ErrTimeout = errors.New("agent: request timed out")

// ErrNotPaired is returned when Ask is called before a successful Pair.
var ErrNotPaired = errors.New("agent: not paired")

// ErrBusy is returned when Ask is called while another Ask is in flight. The
// agent serializes on the single shared session connection (one phone, one
// question at a time); a second concurrent Ask is rejected, never approved.
var ErrBusy = errors.New("agent: another request in flight")

// Asker requests a human decision and blocks until an authenticated answer
// arrives or the deadline passes. This is the consumer interface the MCP
// tool depends on.
type Asker interface {
	// Ask seals req to the paired phone and returns the human's decision,
	// retrying on undeliverable/transport failures until ctx is done.
	Ask(ctx context.Context, req wire.Request) (wire.Decision, error)
}

// pairTTL bounds how long the A-side waits for the phone before abandoning an
// unpaired room. The room is a deterministic function of the low-entropy code,
// so an attacker who derives the room could sit in it and online-guess the
// SPAKE2 password; a short TTL caps that to at most one guess per code
// lifetime. On expiry Pair returns ErrPairing and the caller re-mints a fresh
// code (see MCPServer.pairOnce). ref. ADR code-only pairing security review.
const pairTTL = 3 * time.Minute

// Config holds the agent's runtime settings.
type Config struct {
	// RelayURL is the ws:// (or wss://) endpoint the agent dials.
	RelayURL string
	// PublicRelayURL is the relay URL advertised to the phone when it differs
	// from the URL the agent dials. Used for local HTTPS: the agent dials the
	// plain local relay while the phone connects over a wss:// reverse proxy.
	// Defaults to RelayURL. With code-only pairing nothing is advertised in a
	// URL; this remains only so the agent and phone can dial different relay
	// hostnames in the same deployment.
	PublicRelayURL string
	// AgentName optionally names who is asking (e.g. "cursor @ workstation").
	AgentName string
}

// Agent owns the session key, pairing state, VAPID keypair, and retry loop.
// The zero value is not usable; call New.
type Agent struct {
	cfg  Config
	dial dialer

	// vapidPub/vapidPriv sign the Web Push wake-up. Sourced from
	// AAH_VAPID_PUBLIC_KEY/AAH_VAPID_PRIVATE_KEY when set (so the agent signs
	// with the key the PWA subscribed under) else a fresh RAM-only pair.
	vapidPub  string
	vapidPriv string

	// mu guards sess and sub, which Pair sets and Ask reads.
	mu   sync.Mutex
	sess *Session
	// sub is the phone's Web Push subscription, delivered sealed; the agent
	// sends the contentless wake-up push itself.
	sub *webpush.Subscription

	// asking single-flights Ask: the agent owns one shared session connection,
	// so concurrent Asks would interleave frames on it. A second Ask is
	// rejected with ErrBusy rather than racing.
	asking atomic.Bool
}

var _ Asker = (*Agent)(nil)

// New returns an Agent configured from cfg. The VAPID keypair is chosen in
// priority order:
//  1. AAH_VAPID_PUBLIC_KEY/AAH_VAPID_PRIVATE_KEY when both are set — the
//     highest-priority override for self-hosters who pin a specific key.
//  2. a keypair persisted under the user config dir (vapidStatePath), so the
//     agent signs with the SAME public key across restarts — the phone, which
//     subscribed under the key the agent sent during pairing, keeps receiving
//     wake-ups after a restart.
//  3. a freshly generated pair, written to (2) for next time.
//
// Persistence is best-effort: any read/write error falls back to an in-RAM
// pair so New never fails for push reasons (pairing and decisions still work;
// push is best-effort). It errors only if key generation itself fails.
func New(cfg Config) (*Agent, error) {
	if cfg.RelayURL == "" {
		cfg.RelayURL = defaultRelayURL
	}
	if cfg.PublicRelayURL == "" {
		cfg.PublicRelayURL = cfg.RelayURL
	}
	pub := os.Getenv("AAH_VAPID_PUBLIC_KEY")
	priv := os.Getenv("AAH_VAPID_PRIVATE_KEY")
	if pub == "" || priv == "" {
		var err error
		priv, pub, err = loadOrCreateVAPIDKeys()
		if err != nil {
			return nil, fmt.Errorf("agent: vapid: %w", err)
		}
	}
	return &Agent{cfg: cfg, dial: dialWS, vapidPriv: priv, vapidPub: pub}, nil
}

// vapidKeypair is the persisted VAPID keypair (both halves base64url). Only the
// public half is ever sent over the wire; the private half stays on disk under
// 0600 and never leaves the agent.
type vapidKeypair struct {
	PublicKey  string `json:"public_key"`
	PrivateKey string `json:"private_key"`
}

// vapidStatePath returns the on-disk path for the persisted VAPID keypair:
// <user config dir>/ask-a-human/vapid.json. It errors if the user config dir
// cannot be resolved (honors XDG_CONFIG_HOME / HOME via os.UserConfigDir).
func vapidStatePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "ask-a-human", "vapid.json"), nil
}

// loadOrCreateVAPIDKeys returns a stable VAPID keypair: it loads the persisted
// one when present, else generates a fresh pair and atomically writes it (0600)
// for next time. Persistence is best-effort — a generated pair is returned even
// when it could not be persisted, so push degrades gracefully rather than
// failing New. Returns (priv, pub) to match webpush.GenerateVAPIDKeys.
func loadOrCreateVAPIDKeys() (priv, pub string, err error) {
	path, perr := vapidStatePath()
	if perr == nil {
		if kp, rerr := readVAPIDKeypair(path); rerr == nil {
			return kp.PrivateKey, kp.PublicKey, nil
		}
	}
	priv, pub, err = webpush.GenerateVAPIDKeys()
	if err != nil {
		return "", "", err
	}
	if perr == nil {
		// Best-effort persist: a write failure is non-fatal (push stays
		// best-effort), the in-RAM pair is still returned and usable this run.
		_ = writeVAPIDKeypair(path, vapidKeypair{PublicKey: pub, PrivateKey: priv})
	}
	return priv, pub, nil
}

// readVAPIDKeypair loads and validates the persisted keypair at path. A missing
// file, unreadable bytes, malformed JSON, or an empty half are all errors so the
// caller regenerates.
func readVAPIDKeypair(path string) (vapidKeypair, error) {
	raw, err := os.ReadFile(path) // #nosec G304 -- path is vapidStatePath() under os.UserConfigDir, not user-supplied
	if err != nil {
		return vapidKeypair{}, err
	}
	var kp vapidKeypair
	if err := json.Unmarshal(raw, &kp); err != nil {
		return vapidKeypair{}, err
	}
	if kp.PublicKey == "" || kp.PrivateKey == "" {
		return vapidKeypair{}, errors.New("agent: vapid state: empty key")
	}
	return kp, nil
}

// writeVAPIDKeypair atomically writes kp to path with 0600 perms: it creates the
// parent dir, writes a sibling temp file, then renames it into place so a reader
// never sees a partial file. The private key never leaves disk (0600).
func writeVAPIDKeypair(path string, kp vapidKeypair) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(kp)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// Pairing holds what the agent must show so the phone can join. The human reads
// Display, types it into the PWA, and both sides canonicalize to Canon — which
// is both the SPAKE2 password and the input that derives RoomID. Nothing here
// travels in a URL: RoomID is a one-way function of the code, so it never
// reveals Canon.
type Pairing struct {
	// RoomID is the 16-hex room both peers join, derived from Canon via
	// paircode.RoomFromCode.
	RoomID string
	// Display is the grouped, human-facing code (e.g. "4F2K-9QHR") for printing.
	Display string
	// Canon is the canonical code (paircode.Canonicalize): the SPAKE2 password.
	// It MUST be fed to the handshake, never the Display form.
	Canon string
}

// NewPairing mints a fresh code, canonicalizes it, and derives the room id from
// the canonical form — nothing secret in any URL. Used by
// `pair`/`ask`/start_pairing to print the code before dialing.
func (a *Agent) NewPairing() (Pairing, error) {
	code, err := paircode.NewCode()
	if err != nil {
		return Pairing{}, fmt.Errorf("agent: new code: %w", err)
	}
	canon, err := paircode.Canonicalize(code)
	if err != nil {
		return Pairing{}, fmt.Errorf("agent: canonicalize: %w", err)
	}
	room, err := paircode.RoomFromCode(canon)
	if err != nil {
		return Pairing{}, fmt.Errorf("agent: room from code: %w", err)
	}
	return Pairing{RoomID: room, Display: code, Canon: canon}, nil
}

// Pair runs wormhole-style SPAKE2 pairing (A-side) for p's room over the relay,
// derives the session key, and stores the live session. The CANONICAL code
// (p.Canon) is the SPAKE2 password. The caller is expected to have already
// printed the code (PrintCode). Pairing is bounded by pairTTL: if the phone has
// not paired by then the room is abandoned with ErrPairing so the caller can
// re-mint a fresh code, capping an attacker to one online guess per lifetime.
func (a *Agent) Pair(ctx context.Context, p Pairing) error {
	ctx, cancel := context.WithTimeout(ctx, pairTTL)
	defer cancel()

	sess, err := pairAsA(ctx, a.dial, a.cfg.RelayURL, p.RoomID, p.Canon)
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("%w: pairing window elapsed", ErrPairing)
		}
		return err
	}
	a.mu.Lock()
	a.sess = sess
	a.mu.Unlock()

	// Hand the phone the public key the agent signs wake-ups with, so it
	// subscribes for Web Push under EXACTLY that key (signer == subscribe-key).
	// Sent once, right after pairing, independent of the first request. Only the
	// PUBLIC key crosses the (sealed) wire. Best-effort: a send failure never
	// fails pairing — push is best-effort and the first request still re-wakes.
	if err := a.sendVAPIDKey(ctx, sess); err != nil {
		fmt.Fprintf(os.Stderr, "ask-a-human: could not send vapid key: %v\n", err)
	}
	return nil
}

// sendVAPIDKey seals the agent's VAPID PUBLIC key as a wire.VAPIDKey and sends
// it on sess using the same sealedbox path as app messages. The private key is
// never included. The plaintext is padded to a fixed block by EncodeVAPIDKey so
// its length does not leak to the relay (mirrors EncodeRequest).
func (a *Agent) sendVAPIDKey(ctx context.Context, sess *Session) error {
	plain, err := wire.EncodeVAPIDKey(a.vapidPub)
	if err != nil {
		return fmt.Errorf("agent: encode vapid key: %w", err)
	}
	box, err := sealedbox.Seal(sess.key, plain)
	if err != nil {
		return fmt.Errorf("agent: seal vapid key: %w", err)
	}
	if err := writeEnvelope(ctx, sess.conn, envelope{Box: box}); err != nil {
		return fmt.Errorf("agent: send vapid key: %w", err)
	}
	return nil
}

// Paired reports whether a session has been established.
func (a *Agent) Paired() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sess != nil
}

// VAPIDPublicKey returns the agent's public VAPID key (base64url), so a
// caller could surface it; the phone needs only its own subscription.
func (a *Agent) VAPIDPublicKey() string { return a.vapidPub }

// Config returns the agent's runtime configuration.
func (a *Agent) Config() Config { return a.cfg }

// Ask implements Asker. It seals req to the paired phone and re-announces on
// undeliverable / transport failure with capped exponential backoff until an
// authenticated (sealedbox.Open-verified) decision for req.ID arrives. A bad
// frame is never treated as approval; ctx cancellation/deadline -> ErrTimeout.
func (a *Agent) Ask(ctx context.Context, req wire.Request) (wire.Decision, error) {
	// Single-flight: one phone, one shared connection, one question at a time.
	// Reject (never approve) a concurrent Ask instead of racing on sess.conn.
	if !a.asking.CompareAndSwap(false, true) {
		return wire.Decision{}, ErrBusy
	}
	defer a.asking.Store(false)

	a.mu.Lock()
	sess := a.sess
	a.mu.Unlock()
	if sess == nil {
		return wire.Decision{}, ErrNotPaired
	}

	// Enforce the request's own deadline: a timeout fires the ctx.Err() ->
	// ErrTimeout branches below, returning a zero Decision, never approved.
	if req.ExpiresInS > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(req.ExpiresInS)*time.Second)
		defer cancel()
	}

	req.Kind = wire.KindRequest
	// EncodeRequest pads to a fixed block so the request body length does not
	// leak to the relay via ciphertext-length analysis (mirrors the phone).
	plain, err := wire.EncodeRequest(req)
	if err != nil {
		return wire.Decision{}, fmt.Errorf("agent: encode request: %w", err)
	}

	backoff := baseBackoff
	for {
		if err := ctx.Err(); err != nil {
			return wire.Decision{}, ErrTimeout
		}

		dec, sendErr := a.askOnce(ctx, sess, req, plain)
		if sendErr == nil {
			return dec, nil
		}
		if !errors.Is(sendErr, errResend) {
			return wire.Decision{}, sendErr
		}

		// A transport failure means the live connection is dead: re-dial the
		// same room (no re-pairing). An undeliverable peer (or a peer that
		// left mid-request) means the phone is absent: keep the connection,
		// wake it with a push (best-effort), and wait. A successful reconnect
		// resets the backoff so a later blip starts fresh.
		if errors.Is(sendErr, errReconnect) {
			if reconnectErr := a.reconnect(ctx, sess); reconnectErr != nil {
				if waitErr := sleep(ctx, backoff); waitErr != nil {
					return wire.Decision{}, ErrTimeout
				}
				backoff = nextBackoff(backoff)
				continue
			}
			backoff = baseBackoff
		} else {
			// Best-effort wake. A real failure (push service rejected the
			// signed push, bad endpoint) is worth surfacing; the benign "no
			// subscription yet" case is not — the phone simply hasn't sent one.
			if nerr := a.Notify(ctx); nerr != nil && !errors.Is(nerr, errNoPushSub) {
				fmt.Fprintf(os.Stderr, "ask-a-human: push wake-up failed: %v\n", nerr)
			}
		}
		if waitErr := sleep(ctx, backoff); waitErr != nil {
			return wire.Decision{}, ErrTimeout
		}
		backoff = nextBackoff(backoff)
	}
}

// errResend is the internal signal to re-announce the request. errReconnect
// additionally signals the live connection is dead and must be re-dialed.
var (
	errResend    = errors.New("agent: resend")
	errReconnect = fmt.Errorf("%w: reconnect", errResend)
)

// askOnce seals plain, sends one box, and reads frames until an
// authenticated decision for id arrives. It returns errResend on
// undeliverable / transport failure so Ask can re-announce. Push
// subscriptions that arrive are absorbed and stored.
func (a *Agent) askOnce(ctx context.Context, sess *Session, req wire.Request, plain []byte) (wire.Decision, error) {
	box, err := sealedbox.Seal(sess.key, plain)
	if err != nil {
		return wire.Decision{}, fmt.Errorf("agent: seal: %w", err)
	}
	if err := writeEnvelope(ctx, sess.conn, envelope{Box: box}); err != nil {
		return wire.Decision{}, fmt.Errorf("%w: write: %w", errReconnect, err)
	}

	for {
		env, err := readEnvelope(ctx, sess.conn)
		if err != nil {
			if ctx.Err() != nil {
				return wire.Decision{}, ErrTimeout
			}
			return wire.Decision{}, fmt.Errorf("%w: read: %w", errReconnect, err)
		}
		switch {
		case env.Relay == wire.SignalUndeliverable, env.Relay == wire.SignalPeerLeft:
			// Peer absent or left mid-request: re-announce so the outer Ask
			// loop re-wakes and re-sends when the phone returns.
			return wire.Decision{}, errResend
		case env.Relay != "":
			continue // peer_joined: keep waiting.
		case env.Box == "":
			continue // pake/confirm stragglers post-pairing: ignore.
		}

		plainResp, err := sealedbox.Open(sess.key, env.Box)
		if err != nil {
			// Unauthenticated frame: never trust it, keep waiting.
			continue
		}
		if a.absorbPush(plainResp) {
			continue
		}
		dec, ok := decodeDecision(plainResp, req)
		if !ok {
			continue // wrong id (dup/stale), wrong kind, or shape mismatch.
		}
		return dec, nil
	}
}

// absorbPush stores a sealed push subscription if plain is one, returning
// true when it consumed the message.
func (a *Agent) absorbPush(plain []byte) bool {
	var ps wire.PushSub
	if err := json.Unmarshal(plain, &ps); err != nil {
		return false
	}
	if ps.Kind != wire.KindPushSub || ps.Subscription.Endpoint == "" {
		return false
	}
	a.mu.Lock()
	a.sub = &webpush.Subscription{
		Endpoint: ps.Subscription.Endpoint,
		Keys: webpush.Keys{
			P256dh: ps.Subscription.Keys.P256dh,
			Auth:   ps.Subscription.Keys.Auth,
		},
	}
	a.mu.Unlock()
	return true
}

// decodeDecision parses plain as a wire.Decision for req.ID; ok is false
// unless it is a decision whose ID matches and whose Result shape matches the
// requested ResponseKind. A decision with the wrong shape (e.g. a yesno reply
// missing the approve bool, or a choice not among the offered options) is
// treated as not-yet-valid (ok=false) so Ask keeps waiting — never approved.
func decodeDecision(plain []byte, req wire.Request) (dec wire.Decision, ok bool) {
	if err := json.Unmarshal(plain, &dec); err != nil {
		return wire.Decision{}, false
	}
	if dec.Kind != wire.KindDecision || dec.ID != req.ID {
		return wire.Decision{}, false
	}
	if !resultMatchesKind(dec.Result, req.Response) {
		return wire.Decision{}, false
	}
	return dec, true
}

// resultMatchesKind reports whether res is a well-formed answer for the
// requested response shape. It is a bounded trust-boundary check: a decision
// whose shape does not match the request is rejected, never approved.
func resultMatchesKind(res wire.Result, resp wire.Response) bool {
	switch resp.Kind {
	case wire.ResponseYesNo:
		return res.Approved != nil
	case wire.ResponseChoice:
		if res.Choice == "" {
			return false
		}
		for _, opt := range resp.Options {
			if res.Choice == opt {
				return true
			}
		}
		return false
	case wire.ResponseText:
		if resp.MaxLen > 0 && len(res.Text) > resp.MaxLen {
			return false
		}
		return true
	default:
		return false
	}
}

// reconnect re-dials the relay room and swaps in a fresh connection on the
// session. The session key is unchanged (no re-pairing): both peers rejoin
// the same room id and the agent re-announces. Returns an error if the dial
// or handshake re-confirmation fails.
func (a *Agent) reconnect(ctx context.Context, sess *Session) error {
	_ = sess.conn.close()
	conn, err := sess.dial(ctx, sess.relayURL, sess.roomID)
	if err != nil {
		return err
	}
	sess.conn = conn
	return nil
}

// errNoPushSub is returned by Notify before any subscription has arrived. It is
// a benign, expected state (the phone hasn't sent its subscription yet), so the
// Ask loop skips logging it while still surfacing real push failures.
var errNoPushSub = errors.New("agent: no push subscription")

// Notify sends a contentless wake-up Web Push to the paired phone, signing with
// the agent's VAPID keypair (the same public half the phone subscribed under).
// It returns errNoPushSub if no subscription has arrived yet; a push-service
// rejection includes the HTTP status to aid diagnosis.
func (a *Agent) Notify(ctx context.Context) error {
	a.mu.Lock()
	sub := a.sub
	a.mu.Unlock()
	if sub == nil {
		return errNoPushSub
	}
	resp, err := webpush.SendNotificationWithContext(ctx, []byte("New approval request"), sub, &webpush.Options{
		Subscriber:      vapidSubject,
		VAPIDPublicKey:  a.vapidPub,
		VAPIDPrivateKey: a.vapidPriv,
		TTL:             30,
	})
	if err != nil {
		return fmt.Errorf("agent: push: %w", err)
	}
	// A 2xx is success; anything else means the push service rejected the
	// signed wake-up (e.g. a key mismatch is a 401/403). Surface the status
	// before closing the body so the caller can log it.
	status := resp.StatusCode
	_ = resp.Body.Close()
	if status < 200 || status >= 300 {
		return fmt.Errorf("agent: push: rejected with status %d", status)
	}
	return nil
}

// nextBackoff doubles d up to maxBackoff.
func nextBackoff(d time.Duration) time.Duration {
	d *= 2
	if d > maxBackoff {
		return maxBackoff
	}
	return d
}

// sleep waits d or returns ctx.Err() if ctx ends first.
func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
