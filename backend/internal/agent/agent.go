// Package agent runs next to an AI agent (Cursor/Claude/Codex) as a stdio
// MCP server. It owns the session key (RAM only) and a VAPID keypair (persisted
// 0600 under the user config dir so the signer key stays stable across restarts;
// it only authorizes the fixed, contentless wake-up — it is not the session key
// and cannot decrypt sealed content), runs SPAKE2 pairing, seals/opens
// application messages, sends Web Push to wake the phone, and re-announces a
// pending request until it receives an authenticated decision or times out. A
// failure is never returned as "approved".
//
// See docs/decisions/architecture/0005_relay_ramonly_agent_retries.md and
// docs/plan.md sections 8 and 10.
package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/askahuman/askahuman/backend/pkg/paircode"
	"github.com/askahuman/askahuman/backend/pkg/sealedbox"
	"github.com/askahuman/askahuman/backend/pkg/wire"
)

// requireDeviceSig, when AAH_REQUIRE_DEVICE_SIG=1, forces strict signature
// enforcement: a decision is accepted only if it carries a signature that
// verifies against the phone's device key. Before the phone has delivered a
// device key there is nothing to verify against, so strict mode rejects every
// decision until the key arrives (fail closed). With it off, decisions are
// accepted unsigned until a device key is seen (compat), then signed-only.
var requireDeviceSig = os.Getenv("AAH_REQUIRE_DEVICE_SIG") == "1"

// Default relay endpoint for local dev.
const defaultRelayURL = "ws://127.0.0.1:8080/ws"

// Retry/backoff bounds for the Ask re-announce loop (see plan section 8).
const (
	baseBackoff = 500 * time.Millisecond
	maxBackoff  = 5 * time.Second
)

// defaultVAPIDSubject is the VAPID "sub" contact baked into the wake-up JWT
// (RFC 8292). It MUST be a routable https URL or mailto address: Apple's Web
// Push validates the sub claim and rejects a non-routable/malformed one (e.g. a
// localhost mailto) with HTTP 403 BadJwtToken, so every push silently fails. We
// default to the project's https URL — webpush-go passes an https value through
// verbatim, while it prepends "mailto:" to anything else. The relay never sees
// the subject; it is static sender metadata on a contentless push, not a secret.
const defaultVAPIDSubject = "https://github.com/askahuman/askahuman"

// wakeBody is the FIXED, contentless push payload. The service worker renders a
// generic notification and never echoes wire content, so this string carries no
// request detail; it exists only so the push has a body. ref. ADR 0016, sw.ts.
const wakeBody = "New approval request"

// Web Push delivery tuning. pushTTL is how long the push service retains an
// undelivered wake-up for a briefly-unreachable (sleeping/backgrounded) phone;
// 30s was shorter than the radio wake latency and dropped the nudge, so we hold
// it for the typical request lifetime. UrgencyHigh asks the push service to
// deliver even on low battery. pushWakeTimeout bounds a single proactive push so
// its goroutine cannot outlive the Ask that launched it.
const (
	pushTTL         = 300
	pushWakeTimeout = 10 * time.Second
)

// defaultReWakeInterval throttles the reactive re-wake in the Ask loop. The
// relay re-reports the peer absent on every keepalive cycle, so an unthrottled
// re-wake fired a fresh contentless push on every backoff tick (≤5s apart) —
// the phone buzzed again and again, and iOS surfaced a new banner each time,
// until the human finally answered. Capping re-wakes to one per this interval
// turns that storm into a single wake-up plus an occasional reminder. It sits
// well above maxBackoff (so the storm is gone) yet short enough that a genuinely
// missed proactive nudge — e.g. the push raced ahead of the subscription, or
// iOS dropped the banner — still gets a prompt backup, rather than the human
// waiting minutes (the proactive and reactive wakes share one clock).
const defaultReWakeInterval = 60 * time.Second

// resolveVAPIDSubject returns the VAPID subject: AAH_VAPID_SUBJECT when set, else
// defaultVAPIDSubject. A self-hoster may pass an https URL or a BARE email. We
// strip a stray leading "mailto:" from a non-https override because webpush-go
// re-prepends "mailto:" to any non-https subject, which would otherwise yield an
// invalid doubled "mailto:mailto:<addr>" sub claim.
func resolveVAPIDSubject() string {
	s := strings.TrimSpace(os.Getenv("AAH_VAPID_SUBJECT"))
	if s == "" {
		return defaultVAPIDSubject
	}
	if !strings.HasPrefix(s, "https:") {
		s = strings.TrimPrefix(s, "mailto:")
	}
	return s
}

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
	// with the key the PWA subscribed under) else a keypair persisted 0600 under
	// the user config dir, stable across restarts (see loadOrCreateVAPIDKeys).
	vapidPub  string
	vapidPriv string
	// vapidSub is the routable "sub" contact placed in the wake-up VAPID JWT,
	// resolved once at New from AAH_VAPID_SUBJECT or defaultVAPIDSubject.
	vapidSub string

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

	// peerPresent tracks whether the phone is currently believed to be in the
	// room. The persistent reader sets it true on pairing, a peer_joined, or any
	// authenticated frame, and false on peer_left / an undeliverable write. Ask
	// uses it to annotate a timeout: a present phone means "human is slow"
	// (retry), an absent one means "phone unreachable / lost pairing" (re-pair).
	// A running flag, not "seen since this request started" — the reader now
	// absorbs the phone's post-pairing frames before the first Ask, so a
	// timestamp-since-start would misread a silent-but-connected phone as gone.
	peerPresent atomic.Bool

	// reWakeInterval caps how often the Ask loop's reactive branch re-sends a
	// wake-up push for one request (see defaultReWakeInterval). A field so tests
	// can shrink it; production uses the default set in New.
	reWakeInterval time.Duration

	// waiterMu guards waiter: the single in-flight Ask's mailbox. The persistent
	// session reader (readLoop) routes the matching decision and transport events
	// to it. Single-flight (asking) guarantees at most one waiter at a time.
	waiterMu sync.Mutex
	waiter   *askWaiter

	// readerMu guards the persistent-reader lifecycle. Exactly one reader runs per
	// live session: it owns sess.conn, keeps it alive by reading continuously (so
	// coder/websocket answers the relay's keepalive pings — an unread socket is
	// reaped in ~20-40s), absorbs the push subscription and device key the phone
	// sends right after pairing even when no Ask is in flight, owns reconnect, and
	// delivers decisions to the waiter. readerSess identifies which session it
	// serves so ensureReader is idempotent across Pair and every Ask.
	readerMu     sync.Mutex
	readerSess   *Session
	readerCancel context.CancelFunc
	readerDone   chan struct{}
}

// readerEvent is what the persistent reader tells the in-flight Ask about the
// transport so Ask can re-announce the request.
type readerEvent int

const (
	// evPeerAbsent: the relay reported the request undeliverable or the peer
	// left mid-request — re-announce (and reactively re-wake, throttled).
	evPeerAbsent readerEvent = iota
	// evReconnected: the reader re-dialed a fresh connection after the live one
	// died — re-announce on it (no re-pairing; same room, same key).
	evReconnected
)

// askWaiter is the single in-flight Ask's mailbox, filled by the reader.
// decCh carries the one authenticated, shape-and-signature-valid decision for
// req.ID (buffered 1); evCh carries transport events (best-effort, coalesced).
type askWaiter struct {
	id    string
	req   wire.Request
	decCh chan wire.Decision
	evCh  chan readerEvent
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
	return &Agent{cfg: cfg, dial: dialWS, vapidPriv: priv, vapidPub: pub, vapidSub: resolveVAPIDSubject(), reWakeInterval: defaultReWakeInterval}, nil
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
	a.setPeerPresent(true) // pairing just completed: the phone is provably present

	// Start the persistent reader NOW, before the first request. It keeps the
	// socket alive (an unread socket is reaped by the relay keepalive in
	// ~20-40s) and absorbs the push subscription + device key the phone sends
	// immediately after pairing — the whole reason a later request can wake a
	// backgrounded phone. Without this, those frames land in an unread socket
	// and are lost, and the agent stays Paired() with a dead connection.
	a.ensureReader(sess)

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
	if err := writeEnvelope(ctx, sess.currentConn(), envelope{Box: box}); err != nil {
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

// Close stops the persistent session reader and waits for it to exit, then
// tears down the connection. A host that owns the agent's lifetime (serve
// shutdown, tests) calls it to release the reader goroutine deterministically —
// without it the reader lives for the process. Safe to call more than once and
// when no reader was ever started.
func (a *Agent) Close() {
	a.readerMu.Lock()
	cancel, done := a.readerCancel, a.readerDone
	a.readerSess, a.readerCancel, a.readerDone = nil, nil, nil
	a.readerMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done // wait for readLoop to return so nothing outlives Close.
	}
	a.mu.Lock()
	sess := a.sess
	a.mu.Unlock()
	if sess != nil {
		_ = sess.Close()
	}
}

// Ask implements Asker. It announces req to the paired phone and waits for the
// persistent reader to deliver an authenticated (sealedbox.Open-verified)
// decision for req.ID, re-announcing on undeliverable / peer-left / reconnect.
// A bad frame is never treated as approval; ctx cancellation/deadline ->
// ErrTimeout. The single owning reader (readLoop) does all reading; Ask only
// writes the request and consumes its mailbox, so the connection keeps being
// serviced (and the phone's post-pairing subscription absorbed) between Asks.
func (a *Agent) Ask(ctx context.Context, req wire.Request) (wire.Decision, error) {
	// Single-flight: one phone, one shared connection, one question at a time.
	// Reject (never approve) a concurrent Ask instead of racing on the reader.
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

	// Enforce the request's own deadline: a timeout fires the ctx.Done branch
	// below, returning a zero Decision, never approved.
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

	// Register this Ask's mailbox BEFORE ensuring the reader runs. In a unit test
	// that wires a session directly (bypassing Pair) ensureReader is what starts
	// the reader, and it may immediately read a pre-queued decision — the waiter
	// must already be in place to receive it. In production the reader is already
	// running from Pair and a decision can never precede its own request, so the
	// ordering is moot there.
	w := &askWaiter{id: req.ID, req: req, decCh: make(chan wire.Decision, 1), evCh: make(chan readerEvent, 8)}
	a.waiterMu.Lock()
	a.waiter = w
	a.waiterMu.Unlock()
	defer func() {
		a.waiterMu.Lock()
		a.waiter = nil
		a.waiterMu.Unlock()
	}()

	a.ensureReader(sess)

	// Proactively wake a possibly-backgrounded phone exactly once, fired the
	// moment the request first reaches the wire. iOS silently freezes a
	// backgrounded WebSocket without a clean close, so the relay can keep
	// believing the phone present and deliver the live frame into a dead socket;
	// the reactive re-wake below only fires once the relay's keepalive
	// eventually declares the peer absent (~20-40s). wakeOnce keeps the PROACTIVE
	// wake to one push per Ask so a foregrounded phone (which still shows a banner
	// under userVisibleOnly — see ADR 0016) is not re-alerted for a request it can
	// already see. lastWake also throttles the reactive re-wake.
	var wakeOnce sync.Once
	var lastWake time.Time
	wake := func() {
		wakeOnce.Do(func() {
			lastWake = time.Now()
			go a.wakePush(ctx)
		})
	}

	// Announce the request, then nudge. A write failure is not fatal: the reader
	// owns reconnect and sends evReconnected so we re-announce on the fresh conn.
	_ = a.sendRequest(sess, plain)
	wake()

	// backoff paces re-announces. The relay replies undeliverable to EVERY write
	// into an empty room, so re-announcing the instant that reply lands would be a
	// tight write→undeliverable→write loop against the relay while the phone is
	// away. Cap it with the same exponential backoff the old loop used; a decision
	// or timeout always wins immediately (the wait is interruptible).
	backoff := baseBackoff
	for {
		select {
		case <-ctx.Done():
			return wire.Decision{}, a.timeoutErr()
		case dec := <-w.decCh:
			return dec, nil
		case ev := <-w.evCh:
			switch ev {
			case evPeerAbsent:
				// Peer absent (undeliverable / left mid-request): re-wake it
				// (THROTTLED — the relay re-reports absence on every keepalive
				// cycle, which would otherwise buzz the phone repeatedly; see
				// defaultReWakeInterval), back off, then re-announce so a
				// returning phone sees the request.
				if time.Since(lastWake) >= a.reWakeInterval {
					lastWake = time.Now()
					a.wakePush(ctx)
				}
				select {
				case <-ctx.Done():
					return wire.Decision{}, a.timeoutErr()
				case dec := <-w.decCh:
					return dec, nil
				case <-time.After(backoff):
				}
				_ = a.sendRequest(sess, plain)
				backoff = nextBackoff(backoff)
			case evReconnected:
				// The reader re-dialed a fresh socket after the live one died:
				// re-announce on it at once (no re-pairing; same room and key)
				// and reset the backoff — a fresh connection starts clean.
				_ = a.sendRequest(sess, plain)
				backoff = baseBackoff
			}
		}
	}
}

// setPeerPresent records whether the phone is currently in the room.
func (a *Agent) setPeerPresent(v bool) { a.peerPresent.Store(v) }

// timeoutErr wraps ErrTimeout with what the agent actually observed, so the
// calling model can act instead of blindly retrying: a phone that is not in the
// room has almost certainly lost its pairing (page killed / app removed), and
// only a fresh start_pairing can recover — whereas a phone that is present just
// has a slow human. errors.Is(err, ErrTimeout) holds for both.
func (a *Agent) timeoutErr() error {
	if a.peerPresent.Load() {
		return fmt.Errorf("%w: the phone was reachable but nobody answered — retry, or raise expires_in_s", ErrTimeout)
	}
	return fmt.Errorf("%w: the phone never connected while this request was pending — it has likely lost its pairing; call start_pairing and have the human enter the new code", ErrTimeout)
}

// writeTimeout bounds a single frame write. It is derived from context.Background
// (NOT the request context) so a request that times out never cancels an in-flight
// write — which, with coder/websocket, would close the SHARED connection the
// persistent reader depends on.
const writeTimeout = 10 * time.Second

// sendRequest seals plain and writes it as one box on the session's current
// connection. It never uses the request context for the write (see writeTimeout).
// A write failure is returned but is non-fatal to Ask: the reader owns reconnect.
func (a *Agent) sendRequest(sess *Session, plain []byte) error {
	box, err := sealedbox.Seal(sess.key, plain)
	if err != nil {
		return fmt.Errorf("agent: seal: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	return writeEnvelope(ctx, sess.currentConn(), envelope{Box: box})
}

// ensureReader starts the persistent session reader if one is not already
// running for sess. It is idempotent: Pair starts it right after pairing, and
// every Ask calls it (a no-op in production; in a unit test that wires a session
// directly it is what starts the reader). Starting a reader for a NEW session
// cancels the previous one — re-pairing replaces the session (and its conn).
func (a *Agent) ensureReader(sess *Session) {
	a.readerMu.Lock()
	defer a.readerMu.Unlock()
	if a.readerSess == sess {
		return
	}
	if a.readerCancel != nil {
		a.readerCancel() // stop the reader bound to the previous session.
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	a.readerSess = sess
	a.readerCancel = cancel
	a.readerDone = done
	go a.readLoop(ctx, sess, done)
}

// readLoop is the single owner of sess.conn for the session's lifetime. It reads
// continuously — which is what keeps the socket alive, since coder/websocket only
// answers the relay's keepalive pings while a read is pending (an unread socket is
// reaped in ~20-40s) — dispatches every frame via handleFrame, and owns reconnect:
// a dead live connection is re-dialed (same room, same key — no re-pairing) and
// the in-flight Ask, if any, is told to re-announce. It exits only when its
// context is canceled (teardown / re-pairing).
func (a *Agent) readLoop(ctx context.Context, sess *Session, done chan struct{}) {
	defer close(done)
	backoff := baseBackoff
	for {
		if ctx.Err() != nil {
			return
		}
		env, err := readEnvelope(ctx, sess.currentConn())
		if err == nil {
			backoff = baseBackoff // a healthy read: the connection is good again.
			a.handleFrame(sess, env)
			continue
		}
		if ctx.Err() != nil {
			return // teardown: the cancel closed the conn.
		}
		// Live connection dead: re-dial the same room and, if an Ask is waiting,
		// have it re-announce. Pace reconnects by backoff REGARDLESS of whether
		// the dial itself succeeds — the relay can accept the WebSocket upgrade
		// and then close at once (room full / overloaded, or an LB draining a
		// backend), so resetting the backoff on a successful *dial* would spin a
		// connect→close→connect hot loop that floods the relay and the waiter.
		// Only a successful frame read (above) clears the backoff.
		if a.readerReconnect(ctx, sess) {
			a.notifyWaiter(evReconnected)
		}
		if sleep(ctx, backoff) != nil {
			return
		}
		backoff = nextBackoff(backoff)
	}
}

// readerReconnect closes the dead connection and re-dials the same room, swapping
// in the fresh conn. Returns false when the session has no dialer (unit fakes) or
// the dial fails, so readLoop backs off and retries.
func (a *Agent) readerReconnect(ctx context.Context, sess *Session) bool {
	_ = sess.currentConn().close()
	if sess.dial == nil {
		return false
	}
	conn, err := sess.dial(ctx, sess.relayURL, sess.roomID)
	if err != nil {
		return false
	}
	sess.setConn(conn)
	return true
}

// handleFrame classifies one envelope exactly as the old in-Ask read loop did:
// relay signals update presence / notify the waiter; a box that opens is a push
// subscription, a device key, or a decision. A frame that does not open under the
// session key is never trusted, and only a valid decision is ever routed to Ask.
func (a *Agent) handleFrame(sess *Session, env envelope) {
	switch {
	case env.Relay == wire.SignalUndeliverable, env.Relay == wire.SignalPeerLeft:
		a.setPeerPresent(false)      // the phone is not in the room right now.
		a.notifyWaiter(evPeerAbsent) // absent/left mid-request: Ask re-announces.
		return
	case env.Relay == wire.SignalPeerJoined:
		a.setPeerPresent(true) // phone (re)joined.
		return
	case env.Relay != "":
		return // other relay signals: ignore.
	case env.Box == "":
		return // pake/confirm stragglers post-pairing: ignore.
	}

	plain, err := sealedbox.Open(sess.key, env.Box)
	if err != nil {
		return // unauthenticated frame: never trust it.
	}
	a.setPeerPresent(true) // authenticated frame: only the paired phone can seal it.
	if a.absorbPush(plain) {
		return
	}
	if a.absorbDeviceKey(sess, plain) {
		return
	}
	a.routeDecision(sess, plain)
}

// routeDecision delivers plain to the in-flight Ask iff it is a valid decision
// (matching id, matching shape, and a verifying signature) for the waiting
// request. A decision with no waiter (a stale re-delivery between requests), the
// wrong id, a mismatched shape, or a bad/missing signature is dropped — never
// approved (decodeDecision enforces the trust boundary; see verifyDecisionSig).
func (a *Agent) routeDecision(sess *Session, plain []byte) {
	a.waiterMu.Lock()
	w := a.waiter
	a.waiterMu.Unlock()
	if w == nil {
		return
	}
	dec, ok := decodeDecision(plain, w.req, sess)
	if !ok {
		return
	}
	select {
	case w.decCh <- dec:
	default: // already delivered: drop the duplicate.
	}
}

// notifyWaiter passes a transport event to the in-flight Ask (best-effort: evCh
// is buffered and Ask coalesces re-announces, so a full channel simply drops a
// redundant trigger).
func (a *Agent) notifyWaiter(ev readerEvent) {
	a.waiterMu.Lock()
	w := a.waiter
	a.waiterMu.Unlock()
	if w == nil {
		return
	}
	select {
	case w.evCh <- ev:
	default:
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

// absorbDeviceKey consumes a sealed wire.DeviceKey frame, recording the phone's
// ECDSA P-256 public key on the session so later decisions can be signature-
// verified (mirrors absorbPush). It returns true when the frame WAS a
// device_key — so askOnce stops treating it as a decision — whether or not the
// key parsed; a malformed key is noted on stderr and dropped, never silently
// reinterpreted.
//
// The key is PINNED first-seen: the first valid device key for the session is
// recorded and any LATER, different key is rejected. This pin is what makes the
// signature meaningful against the very thief this feature targets — a
// device_key frame is only session-key-sealed, so an attacker who stole the
// persisted session key could otherwise seal a frame carrying their OWN device
// key, overwrite the pin, and sign a forged approval that verifies. The real
// phone establishes its key at pairing (when only it is the room peer), so the
// pin is the real key; a re-send of the SAME key on reconnect/restore is a
// no-op. See docs/decisions/architecture/0021.
//
// sess.devicePub is touched only from the Ask read-loop; sequential Asks run on
// different goroutines but are serialized by the asking single-flight atomic
// (which establishes the happens-before), so it needs no lock.
func (a *Agent) absorbDeviceKey(sess *Session, plain []byte) bool {
	var dk wire.DeviceKey
	if err := json.Unmarshal(plain, &dk); err != nil {
		return false
	}
	if dk.Kind != wire.KindDeviceKey {
		return false
	}
	pub, err := parseDevicePub(dk.PublicKey)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ask-a-human: ignoring malformed device key: %v\n", err)
		return true // it IS a device_key frame: consume it regardless.
	}
	if sess.devicePub != nil {
		// Pin first-seen: reject a swap. A re-send of the same key is a benign
		// no-op; a DIFFERENT key means either a stray frame or a session-key
		// thief trying to substitute their own signer — never overwrite the pin.
		if !sess.devicePub.Equal(pub) {
			fmt.Fprintf(os.Stderr, "ask-a-human: ignoring device key change (pinned)\n")
		}
		return true
	}
	sess.devicePub = pub // pin first-seen
	return true
}

// parseDevicePub decodes a base64 SPKI DER string into an ECDSA P-256 public
// key, rejecting anything that is not a P-256 ECDSA key.
func parseDevicePub(spkiB64 string) (*ecdsa.PublicKey, error) {
	if spkiB64 == "" {
		return nil, errors.New("agent: empty device key")
	}
	der, err := base64.StdEncoding.DecodeString(spkiB64)
	if err != nil {
		return nil, fmt.Errorf("agent: device key b64: %w", err)
	}
	pubAny, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, fmt.Errorf("agent: device key parse: %w", err)
	}
	pub, ok := pubAny.(*ecdsa.PublicKey)
	if !ok {
		return nil, errors.New("agent: device key not ecdsa")
	}
	if pub.Curve != elliptic.P256() {
		return nil, errors.New("agent: device key not p256")
	}
	return pub, nil
}

// decodeDecision parses plain as a wire.Decision for req.ID; ok is false
// unless it is a decision whose ID matches, whose Result shape matches the
// requested ResponseKind, AND whose signature satisfies verifyDecisionSig. A
// decision with the wrong shape (e.g. a yesno reply missing the approve bool, or
// a choice not among the offered options) or a missing/invalid signature is
// treated as not-yet-valid (ok=false) so Ask keeps waiting — never approved.
func decodeDecision(plain []byte, req wire.Request, sess *Session) (dec wire.Decision, ok bool) {
	if err := json.Unmarshal(plain, &dec); err != nil {
		return wire.Decision{}, false
	}
	if dec.Kind != wire.KindDecision || dec.ID != req.ID {
		return wire.Decision{}, false
	}
	if !resultMatchesKind(dec.Result, req.Response) {
		return wire.Decision{}, false
	}
	if !verifyDecisionSig(sess, dec) {
		return wire.Decision{}, false
	}
	return dec, true
}

// verifyDecisionSig enforces the per-device signature. Once the phone has
// delivered a device key (sess.devicePub != nil), every decision MUST carry a
// signature that verifies against that key over DecisionSigningMessage — a
// stolen session key can decrypt traffic but cannot forge an approval. Before
// any device key, an unsigned decision is accepted (compat with an older phone)
// UNLESS strict mode (AAH_REQUIRE_DEVICE_SIG=1) is on, which rejects until a key
// arrives. A bad or missing signature is never an approval: it returns false so
// Ask keeps waiting. The wire signature is raw IEEE-P1363 r||s (64 bytes), so it
// is verified with ecdsa.Verify (NOT VerifyASN1, which expects DER).
func verifyDecisionSig(sess *Session, dec wire.Decision) bool {
	if sess.devicePub == nil {
		return !requireDeviceSig // no key to verify against: compat unless strict.
	}
	if dec.Sig == "" {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(dec.Sig)
	if err != nil || len(sig) != 64 {
		return false
	}
	msg := wire.DecisionSigningMessage(sess.roomID, dec.ID, dec.Result)
	digest := sha256.Sum256(msg)
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	return ecdsa.Verify(sess.devicePub, digest[:], r, s)
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

// errNoPushSub is returned by Notify before any subscription has arrived. It is
// a benign, expected state (the phone hasn't sent its subscription yet), so the
// Ask loop skips logging it while still surfacing real push failures.
var errNoPushSub = errors.New("agent: no push subscription")

// Notify sends a contentless wake-up Web Push to the paired phone, signing with
// the agent's VAPID keypair (the same public half the phone subscribed under)
// and a routable VAPID subject (a.vapidSub) so Apple's push service accepts the
// JWT. It returns errNoPushSub if no subscription has arrived yet; a push-service
// rejection includes the HTTP status to aid diagnosis. A 404/410 means the
// endpoint is permanently gone, so the stored subscription is dropped (the phone
// re-subscribes and re-delivers it sealed on its next pairing/resume).
func (a *Agent) Notify(ctx context.Context) error {
	a.mu.Lock()
	sub := a.sub
	a.mu.Unlock()
	if sub == nil {
		return errNoPushSub
	}
	resp, err := webpush.SendNotificationWithContext(ctx, []byte(wakeBody), sub, &webpush.Options{
		Subscriber:      a.vapidSub,
		VAPIDPublicKey:  a.vapidPub,
		VAPIDPrivateKey: a.vapidPriv,
		Urgency:         webpush.UrgencyHigh,
		TTL:             pushTTL,
	})
	if err != nil {
		return fmt.Errorf("agent: push: %w", err)
	}
	// A 2xx is success; anything else means the push service rejected the
	// signed wake-up (e.g. a key/subject mismatch is a 401/403). Surface the
	// status before closing the body so the caller can log it.
	status := resp.StatusCode
	_ = resp.Body.Close()
	if status == http.StatusNotFound || status == http.StatusGone {
		// Permanently gone endpoint: drop the dead subscription so we stop
		// signing pushes to it (and so errNoPushSub resumes until a fresh one
		// arrives). Guard against clobbering a subscription swapped in meanwhile.
		a.mu.Lock()
		if a.sub == sub {
			a.sub = nil
		}
		a.mu.Unlock()
		return fmt.Errorf("agent: push: endpoint gone (status %d)", status)
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("agent: push: rejected with status %d", status)
	}
	return nil
}

// wakePush sends one best-effort contentless wake-up, bounded by pushWakeTimeout
// so the goroutine that runs it (see Ask) cannot outlive the request. The benign
// "no subscription yet" case is not logged (the phone simply hasn't delivered
// its subscription); a real push-service failure is surfaced on stderr.
func (a *Agent) wakePush(ctx context.Context) {
	wctx, cancel := context.WithTimeout(ctx, pushWakeTimeout)
	defer cancel()
	if err := a.Notify(wctx); err != nil && !errors.Is(err, errNoPushSub) {
		fmt.Fprintf(os.Stderr, "ask-a-human: push wake-up failed: %v\n", err)
	}
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
