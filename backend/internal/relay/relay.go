// Package relay is the stateless, content-blind WebSocket rendezvous. It
// groups connections into rooms of two keyed by room id, forwards opaque
// frames verbatim between the two peers, and injects peer_joined /
// peer_left / undeliverable signals. It holds no keys, no content, and no
// database: the only state is "who is connected right now," in RAM.
// Restart => clients re-pair.
//
// See docs/decisions/architecture/0005_relay_ramonly_agent_retries.md and
// docs/plan.md sections 2 and 5.
package relay

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/askahuman/askahuman/backend/pkg/wire"
)

// verbose enables per-connection logging (room id + client IP + accept errors).
// Off by default to preserve the relay's privacy property in prod; set
// AAH_RELAY_VERBOSE=1 in dev to observe pairing. Never logs frame content.
var verbose = os.Getenv("AAH_RELAY_VERBOSE") == "1"

// logf logs only when verbose is enabled.
func logf(format string, args ...any) {
	if verbose {
		log.Printf(format, args...)
	}
}

// trustProxy, when AAH_RELAY_TRUST_PROXY=1, makes clientIP read the rightmost
// X-Forwarded-For hop (the IP the trusted L7 LB observed) instead of RemoteAddr.
// Default OFF: direct-exposure deployments must NOT trust a client-supplied XFF.
var trustProxy = os.Getenv("AAH_RELAY_TRUST_PROXY") == "1"

// clientIP returns the key for the per-IP cap (and dev logging): the rightmost
// X-Forwarded-For hop when behind a trusted proxy (the IP the trusted LB saw),
// else the direct TCP peer. ref. m3-relay-xff: never trust a client-supplied
// leftmost XFF; the rightmost hop is the one the trusted LB appended.
func clientIP(req *http.Request) string {
	host := remoteHost(req.RemoteAddr)
	if !trustProxy {
		return host
	}
	if ip := rightmostXFF(req.Header.Get("X-Forwarded-For")); ip != "" {
		return ip
	}
	return host
}

// remoteHost strips the port from a host:port, returning addr unchanged if it
// has none.
func remoteHost(addr string) string {
	h, _, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return h
}

// rightmostXFF returns the last syntactically-valid IP in an X-Forwarded-For
// header value, or "" when none parses. The rightmost hop is the one the
// trusted proxy appended; earlier (leftmost) hops are client-controllable and
// must not be trusted as the cap key. ponytail: trusts exactly one proxy hop —
// for N chained trusted proxies, skip N-1 from the right.
func rightmostXFF(xff string) string {
	parts := strings.Split(xff, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		h := strings.TrimSpace(parts[i])
		// Tolerate an accidental host:port hop.
		if hh := remoteHost(h); net.ParseIP(hh) != nil {
			return hh
		}
	}
	return ""
}

// StatusRoomFull is the WebSocket close code returned when a third peer
// tries to join a room that already holds two. Part of the wire contract.
const StatusRoomFull websocket.StatusCode = 4001

// StatusOverloaded is the WebSocket close code returned when the relay is at
// its global room cap or this client's per-IP connection cap. The client
// should back off and retry rather than treat it as a protocol error.
const StatusOverloaded websocket.StatusCode = 4002

// StatusPolicyViolation is the WebSocket close code returned when a client
// sends a frame it must never send (a _relay control signal): only the relay
// injects relay control frames. ref. wire.Frame.Relay "clients never set it".
const StatusPolicyViolation websocket.StatusCode = 4003

// DoS caps for the untrusted, internet-facing relay. These bound RAM and
// per-IP fan-out so a single client cannot exhaust the process. Both accept
// an env override for ops tuning (AAH_RELAY_MAX_ROOMS, AAH_RELAY_MAX_CONNS_PER_IP).
var (
	// maxRooms caps the number of simultaneously live rooms.
	maxRooms = envInt("AAH_RELAY_MAX_ROOMS", 10000)
	// maxConnsPerIP caps simultaneous connections from one client IP. A
	// legitimate pairing needs at most one connection per IP per room, so a
	// small cap still allows several rooms behind one NAT.
	maxConnsPerIP = envInt("AAH_RELAY_MAX_CONNS_PER_IP", 64)
)

// maxFrameBytes bounds a single inbound WebSocket frame (SetReadLimit). App
// frames are small JSON envelopes around a base64 box; 32KiB is generous.
const maxFrameBytes = 32 << 10

// readHeaderTimeout bounds only the HTTP request-header phase (Slowloris
// defense). It does not bound the long-lived WebSocket body.
const readHeaderTimeout = 10 * time.Second

// maxHeaderBytes bounds the size of HTTP request headers.
const maxHeaderBytes = 1 << 16

// msgRateBurst / msgRateWindow form a simple per-connection message rate
// limit: at most msgRateBurst frames per msgRateWindow. A peer exceeding it is
// dropped. Generous enough for interactive pairing + approval traffic.
const (
	msgRateBurst  = 120
	msgRateWindow = time.Second
)

// envInt reads name as an int, falling back to def when unset/invalid/non-positive.
func envInt(name string, def int) int {
	v := os.Getenv(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

// roomIDLen is the exact length of a valid room id: 16 hex chars (8 bytes),
// as produced by paircode.RoomFromCode and mirrored by the PWA. ref.
// backend/pkg/paircode/paircode.go RoomFromCode.
const roomIDLen = 16

// validRoomID reports whether id is a well-formed room id: exactly roomIDLen
// hex characters. Bounds the registry key and rejects junk before allocating.
func validRoomID(id string) bool {
	if len(id) != roomIDLen {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= '0' && c <= '9':
		case c >= 'a' && c <= 'f':
		case c >= 'A' && c <= 'F':
		default:
			return false
		}
	}
	return true
}

// pingInterval is how often the relay pings each connection to drop dead
// ones (see docs/plan.md section 0 keepalive).
const pingInterval = 20 * time.Second

// probeTimeout bounds one liveness ping during a room-full probe (see
// probeRoom). Short on purpose: a healthy peer pongs in well under a second,
// and a false positive only forces that peer through its normal reconnect.
// A var so tests can shrink it.
var probeTimeout = 2 * time.Second

// shutdownGrace bounds how long Serve waits for in-flight handlers on
// graceful shutdown.
const shutdownGrace = 5 * time.Second

// acceptOptions are the WebSocket accept options used when upgrading a
// peer connection. The PWA is served from a different origin than the
// relay in dev (and behind separate ingress hosts in prod), so cross-origin
// upgrades must be permitted. The relay carries only opaque ciphertext, so
// there is no CSRF-sensitive state to protect.
var acceptOptions = &websocket.AcceptOptions{InsecureSkipVerify: true}

// Relay is the in-RAM rendezvous. The zero value is not usable; call New.
type Relay struct {
	// mu guards rooms, connsPerIP, and every room's peers slice. The relay
	// does no IO while holding it: a peer's outbound frame is captured under
	// the lock (the peer pointer), then written without the lock held.
	mu sync.Mutex
	// rooms maps a room id to its (at most two) connected peers.
	rooms map[string]*room
	// connsPerIP counts live connections per client IP, for the per-IP cap.
	// Entries are decremented in leave() and deleted at zero.
	connsPerIP map[string]int
}

// room is a single rendezvous of at most two peers. Its fields are guarded by
// Relay.mu.
type room struct {
	// peers holds the at-most-two connected peers.
	peers []*peer
	// probing is true while a room-full liveness probe is in flight, so
	// repeated rejected joins (a client retrying with backoff) coalesce into
	// one probe at a time.
	probing bool
}

// peer is one connected WebSocket side. writeMu serializes writes to conn
// (coder/websocket forbids concurrent writers); it is independent of
// Relay.mu so forwarding never blocks the registry.
type peer struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
}

// New returns a Relay ready to accept connections.
func New() *Relay {
	return &Relay{
		rooms:      make(map[string]*room),
		connsPerIP: make(map[string]int),
	}
}

// Handler returns the HTTP handler that upgrades /ws?room=<id> to a
// WebSocket and joins the caller to that room.
func (r *Relay) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		roomID := req.URL.Query().Get("room")
		if roomID == "" {
			http.Error(w, "relay: missing room", http.StatusBadRequest)
			return
		}
		// Bounded validation BEFORE allocating anything: reject junk/oversized
		// room ids that never match a real (16-hex) id.
		if !validRoomID(roomID) {
			http.Error(w, "relay: invalid room", http.StatusBadRequest)
			return
		}

		// Reserve a per-IP slot before the upgrade so an abusive client is
		// rejected without us allocating a WebSocket. Released on Accept
		// failure here, otherwise in leave().
		ip := clientIP(req)
		if !r.reserveIP(ip) {
			http.Error(w, "relay: too many connections", http.StatusServiceUnavailable)
			logf("relay: per-IP cap, rejecting remote=%s", ip)
			return
		}

		conn, err := websocket.Accept(w, req, acceptOptions)
		if err != nil {
			r.releaseIP(ip)
			// Accept already wrote a response on failure.
			logf("relay: accept FAILED room=%s remote=%s origin=%q: %v",
				roomID, ip, req.Header.Get("Origin"), err)
			return
		}
		// Bound a single inbound frame so a peer can't send a giant frame.
		conn.SetReadLimit(maxFrameBytes)
		logf("relay: ws open room=%s remote=%s origin=%q", roomID, ip, req.Header.Get("Origin"))
		r.serveConn(req.Context(), roomID, ip, conn)
	}
}

// serveConn registers conn in roomID, pumps its frames to the peer, and
// cleans up on disconnect. It blocks until the connection ends. ip is the
// reserved per-IP slot, released when the connection ends.
func (r *Relay) serveConn(ctx context.Context, roomID, ip string, conn *websocket.Conn) {
	p := &peer{conn: conn}

	status := r.join(roomID, p)
	switch status {
	case joinRoomFull:
		logf("relay: room FULL, rejecting third peer room=%s", roomID)
		// The fullness is often the joiner's OWN previous, silently-dead socket
		// (an iOS PWA resume): probe the current peers so a zombie is reaped in
		// seconds instead of waiting out the keepalive cycle. The rejected
		// client retries with backoff and gets in once the slot frees.
		go r.probeRoom(roomID)
		_ = conn.Close(StatusRoomFull, "relay: room full")
		r.releaseIP(ip)
		return
	case joinOverloaded:
		logf("relay: at global room cap, rejecting room=%s", roomID)
		_ = conn.Close(StatusOverloaded, "relay: overloaded")
		r.releaseIP(ip)
		return
	}
	defer r.leave(roomID, ip, p)

	// If the peer is already present, tell this newcomer immediately.
	if other := r.peerOf(roomID, p); other != nil {
		logf("relay: PAIRED room=%s (both peers present)", roomID)
		writeSignal(ctx, p, wire.SignalPeerJoined)
	} else {
		logf("relay: waiting for peer room=%s (1/2)", roomID)
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go r.keepalive(ctx, p)

	r.pump(ctx, roomID, p)
}

// pump reads frames from p and forwards each verbatim to p's peer, or
// replies undeliverable to p when no peer is present.
func (r *Relay) pump(ctx context.Context, roomID string, p *peer) {
	var (
		count       int
		windowStart = time.Now()
	)
	for {
		typ, data, err := p.conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue // app frames are JSON text; ignore binary.
		}

		// Per-connection rate limit: drop a peer that floods us. Fixed-window
		// counter; ponytail: coarse but enough to bound a single conn — swap
		// for a token bucket if finer pacing is ever needed.
		if now := time.Now(); now.Sub(windowStart) >= msgRateWindow {
			windowStart = now
			count = 0
		}
		count++
		if count > msgRateBurst {
			logf("relay: rate limit exceeded room=%s, closing", roomID)
			_ = p.conn.Close(StatusPolicyViolation, "relay: rate limit")
			return
		}

		// Reject client-set relay control frames: only the relay injects
		// _relay signals. A peer setting _relay could spoof peer_joined /
		// peer_left / undeliverable to the other side. We inspect ONLY the
		// _relay field and never the opaque box, so we stay content-blind.
		if relaySet(data) {
			logf("relay: client sent _relay, closing room=%s", roomID)
			_ = p.conn.Close(StatusPolicyViolation, "relay: clients must not set _relay")
			return
		}

		other := r.peerOf(roomID, p)
		if other == nil {
			writeSignal(ctx, p, wire.SignalUndeliverable)
			continue
		}
		// Forward verbatim. The relay never parses app frames.
		writeRaw(ctx, other, data)
	}
}

// relaySet reports whether a client text frame carries a non-empty _relay
// control field. It decodes only into wire.Frame (the relay-visible envelope);
// the opaque box field is never inspected, preserving content-blindness. A
// frame that does not parse as JSON is treated as not setting _relay and is
// forwarded verbatim (the relay does not validate app frames).
func relaySet(data []byte) bool {
	var f wire.Frame
	if err := json.Unmarshal(data, &f); err != nil {
		return false
	}
	return f.Relay != ""
}

// probeRoom pings every current peer of roomID once; a peer that fails to
// pong within probeTimeout is closed, so its pump exits and leave() frees the
// slot (and tells the survivor peer_left). Fired when a joiner is rejected on
// a full room — without it, a silently-dead peer (an iOS PWA whose socket the
// OS froze without a close) blocks its own reconnect for up to two keepalive
// cycles. At most one probe runs per room at a time.
func (r *Relay) probeRoom(roomID string) {
	r.mu.Lock()
	rm := r.rooms[roomID]
	if rm == nil || rm.probing {
		r.mu.Unlock()
		return
	}
	rm.probing = true
	peers := append([]*peer(nil), rm.peers...)
	r.mu.Unlock()

	var wg sync.WaitGroup
	for _, p := range peers {
		wg.Add(1)
		go func(p *peer) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
			defer cancel()
			if err := p.conn.Ping(ctx); err != nil {
				// Dead socket: closing it unblocks its pump, which leaves the
				// room and releases the slot.
				_ = p.conn.CloseNow()
			}
		}(p)
	}
	wg.Wait()

	// Clear on the captured room: if it was emptied and deleted meanwhile this
	// is a harmless write to garbage; a recreated room starts probing=false.
	r.mu.Lock()
	rm.probing = false
	r.mu.Unlock()
}

// keepalive pings p every pingInterval; a failed ping drops the connection.
func (r *Relay) keepalive(ctx context.Context, p *peer) {
	t := time.NewTicker(pingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pctx, cancel := context.WithTimeout(ctx, pingInterval)
			err := p.conn.Ping(pctx)
			cancel()
			if err != nil {
				_ = p.conn.CloseNow()
				return
			}
		}
	}
}

// joinStatus is the outcome of a join attempt.
type joinStatus int

const (
	// joinOK means p was added to the room.
	joinOK joinStatus = iota
	// joinRoomFull means the room already holds two peers; p was not added.
	joinRoomFull
	// joinOverloaded means the global room cap was hit creating a new room;
	// p was not added.
	joinOverloaded
)

// join adds p to roomID. When p becomes the second peer, the already-present
// peer is told its peer joined. It rejects (without adding) when the room is
// full or when creating a new room would exceed the global room cap.
func (r *Relay) join(roomID string, p *peer) joinStatus {
	r.mu.Lock()
	rm := r.rooms[roomID]
	if rm == nil {
		if len(r.rooms) >= maxRooms {
			r.mu.Unlock()
			return joinOverloaded
		}
		rm = &room{}
		r.rooms[roomID] = rm
	}
	if len(rm.peers) >= 2 {
		r.mu.Unlock()
		return joinRoomFull
	}
	rm.peers = append(rm.peers, p)
	var existing *peer
	if len(rm.peers) == 2 {
		existing = rm.peers[0]
	}
	r.mu.Unlock()

	if existing != nil {
		writeSignal(context.Background(), existing, wire.SignalPeerJoined)
	}
	return joinOK
}

// reserveIP reserves one connection slot for ip. It returns false (reserving
// nothing) when ip is already at maxConnsPerIP.
func (r *Relay) reserveIP(ip string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.connsPerIP[ip] >= maxConnsPerIP {
		return false
	}
	r.connsPerIP[ip]++
	return true
}

// releaseIP returns one connection slot for ip, deleting the entry at zero so
// the map cannot grow without bound.
func (r *Relay) releaseIP(ip string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := r.connsPerIP[ip] - 1
	if n <= 0 {
		delete(r.connsPerIP, ip)
		return
	}
	r.connsPerIP[ip] = n
}

// leave removes p from roomID, releases p's per-IP slot, notifies the
// remaining peer, and deletes the room when empty.
func (r *Relay) leave(roomID, ip string, p *peer) {
	defer r.releaseIP(ip)
	r.mu.Lock()
	rm := r.rooms[roomID]
	if rm == nil {
		r.mu.Unlock()
		return
	}
	var remaining *peer
	kept := rm.peers[:0]
	for _, q := range rm.peers {
		if q == p {
			continue
		}
		kept = append(kept, q)
		remaining = q
	}
	rm.peers = kept
	if len(rm.peers) == 0 {
		delete(r.rooms, roomID)
	}
	r.mu.Unlock()

	if remaining != nil {
		writeSignal(context.Background(), remaining, wire.SignalPeerLeft)
	}
	_ = p.conn.CloseNow()
}

// peerOf returns the other peer in roomID, or nil if p is alone.
func (r *Relay) peerOf(roomID string, p *peer) *peer {
	r.mu.Lock()
	defer r.mu.Unlock()
	rm := r.rooms[roomID]
	if rm == nil {
		return nil
	}
	for _, q := range rm.peers {
		if q != p {
			return q
		}
	}
	return nil
}

// writeRaw writes data verbatim to p as a text frame, serialized by p's
// write lock. Errors drop the frame; the read loop will surface the
// disconnect.
func writeRaw(ctx context.Context, p *peer, data []byte) {
	wctx, cancel := context.WithTimeout(ctx, pingInterval)
	defer cancel()
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	_ = p.conn.Write(wctx, websocket.MessageText, data)
}

// writeSignal sends a relay-injected control frame to p.
func writeSignal(ctx context.Context, p *peer, sig wire.RelaySignal) {
	b, err := json.Marshal(wire.Frame{Relay: sig})
	if err != nil {
		return
	}
	writeRaw(ctx, p, b)
}

// Health is the liveness/readiness probe handler for /healthz.
func (r *Relay) Health(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// Mux returns the relay's HTTP routes: /ws and /healthz.
func (r *Relay) Mux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", r.Handler())
	mux.HandleFunc("/healthz", r.Health)
	return mux
}

// Serve starts the relay HTTP server on addr and blocks until ctx is
// canceled (graceful shutdown) or the server fails.
func (r *Relay) Serve(ctx context.Context, addr string) error {
	srv := &http.Server{
		Addr:    addr,
		Handler: r.Mux(),
		// No read/write timeouts on the body: WebSocket connections are
		// long-lived and coder/websocket manages per-frame deadlines and the
		// ping keepalive. ReadHeaderTimeout + MaxHeaderBytes bound ONLY the
		// HTTP header phase (Slowloris defense) and do not affect the WS body.
		ReadHeaderTimeout: readHeaderTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		BaseContext:       func(_ net.Listener) context.Context { return ctx },
	}

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		sctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		return srv.Shutdown(sctx)
	}
}
