package agent

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

// pairPage is a loopback-only, single-tab web page that shows the pairing code
// to the human and reflects pairing success so the browser tab can self-close.
// It is the convenience surface for clients (Cursor, Codex) that bury the MCP
// server's stderr where a non-engineer can never find it; the stderr PrintCode
// line remains the always-on floor beneath it.
//
// SECURITY: the code is the ENTIRE SPAKE2 password. It is written ONLY into the
// page BODY served over 127.0.0.1 — never into a URL, an MCP tool result, the
// transcript, or any log. The page is reachable only at an unguessable 256-bit
// single-use nonce path, bound to loopback, with `Cache-Control: no-store` and a
// `default-src 'none'` CSP so the page makes no third-party request. A co-resident
// process would have to be on THIS host AND guess the nonce to read it; SPAKE2's
// one-online-guess-per-TTL bound (key-confirmation abort + void-and-re-mint)
// backstops even that. The nonce path is deliberately never surfaced to the model.
type pairPage struct {
	srv     *http.Server
	url     string // http://127.0.0.1:<port>/p/<nonce>
	nonce   string
	path    string // "/p/<nonce>" — the page path; status is path+"/status"
	display string // the grouped human-facing code, e.g. "4F2K-9QHR"

	mu        sync.Mutex
	paired    bool
	pairedCh  chan struct{} // closed once when pairing succeeds — long-poll wakeup
	closingCh chan struct{} // closed once when the server is shutting down

	pairOnce  sync.Once
	closeOnce sync.Once
}

// pageTTL bounds how long the loopback server lingers in the worst case if the
// handshake never completes and nothing tears it down; the caller normally
// closes it on pair-success or failure well before this.
const pageTTL = 10 * time.Minute

// pageGrace is the window kept open AFTER pairing succeeds so the tab's held
// long-poll resolves and it can self-close before the server shuts down. The
// flip itself is instant (pairedCh wakeup); this is just teardown slack.
const pageGrace = 10 * time.Second

// statusWait caps how long a single /status long-poll blocks before returning
// so the browser re-issues; it does not gate the flip, which fires the instant
// pairedCh closes.
const statusWait = 20 * time.Second

// openCodePage mints a loopback pair page for displayCode and opens it in the
// host's default browser. It returns the page handle (so the caller can mark it
// paired + tear it down) or an error if the page could not be served or no
// browser could be opened — in which case the caller falls back to the stderr
// code that PrintCode already showed. It NEVER returns the URL to the caller in
// a form that could reach the model.
func openCodePage(displayCode string) (*pairPage, error) {
	p, err := newPairPage(displayCode)
	if err != nil {
		return nil, err
	}
	if err := openBrowser(p.url); err != nil {
		p.close()
		return nil, fmt.Errorf("agent: open browser: %w", err)
	}
	return p, nil
}

// newPairPage binds a fresh loopback listener, mints a 256-bit nonce path, and
// starts serving the code page in the background. It does NOT open a browser
// (openCodePage does); splitting the two keeps the page server unit-testable
// without spawning a browser.
func newPairPage(displayCode string) (*pairPage, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("agent: pair page listen: %w", err)
	}
	nonce, err := randNonce()
	if err != nil {
		_ = ln.Close()
		return nil, err
	}
	p := &pairPage{
		nonce:     nonce,
		path:      "/p/" + nonce,
		url:       "http://" + ln.Addr().String() + "/p/" + nonce,
		display:   displayCode,
		pairedCh:  make(chan struct{}),
		closingCh: make(chan struct{}),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", p.handle)
	p.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = p.srv.Serve(ln) }()
	go func() {
		time.Sleep(pageTTL)
		p.close()
	}()
	return p, nil
}

// markPaired flips the page to its "connected" state and wakes every held
// /status long-poll at once, so the tab shows "Connected" and self-closes the
// instant pairing completes — no poll-interval lag.
func (p *pairPage) markPaired() {
	p.mu.Lock()
	p.paired = true
	p.mu.Unlock()
	p.pairOnce.Do(func() { close(p.pairedCh) })
}

// closeAfter tears the server down after d, off the caller's goroutine, so the
// caller can return immediately while the tab keeps showing "connected".
func (p *pairPage) closeAfter(d time.Duration) {
	go func() {
		time.Sleep(d)
		p.close()
	}()
}

// close shuts the loopback server down. It is idempotent and safe to call from
// the success path, the failure path, and the TTL watchdog concurrently. It
// first releases any held /status long-poll so Shutdown is not blocked waiting
// on an in-flight request.
func (p *pairPage) close() {
	p.closeOnce.Do(func() {
		close(p.closingCh)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = p.srv.Shutdown(ctx)
	})
}

// waitPaired long-polls: it returns true as soon as the page is marked paired,
// or false if the request is canceled, the server is closing, or statusWait
// elapses (the browser then re-issues). This makes the "connected" flip instant
// and removes the poll-lag/teardown race that a fixed-interval poll has.
func (p *pairPage) waitPaired(ctx context.Context) bool {
	p.mu.Lock()
	paired := p.paired
	p.mu.Unlock()
	if paired {
		return true
	}
	select {
	case <-p.pairedCh:
		return true
	case <-p.closingCh:
		return false
	case <-ctx.Done():
		return false
	case <-time.After(statusWait):
		return false
	}
}

// handle serves the code page at /p/<nonce> and the poll endpoint at
// /p/<nonce>/status. Every other path (including a leaked-port probe that lacks
// the nonce) gets a 404. The nonce is compared in constant time so a timing
// side channel cannot recover it.
func (p *pairPage) handle(w http.ResponseWriter, r *http.Request) {
	// Hardening headers on every response: no caching of the code, no referrer
	// leak, and a CSP that forbids any outbound request from the page.
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Security-Policy",
		"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'")

	rest, ok := strings.CutPrefix(r.URL.Path, "/p/")
	if !ok {
		http.NotFound(w, r)
		return
	}
	seg, sub, _ := strings.Cut(rest, "/")
	if subtle.ConstantTimeCompare([]byte(seg), []byte(p.nonce)) != 1 {
		http.NotFound(w, r)
		return
	}

	switch sub {
	case "":
		p.mu.Lock()
		paired := p.paired
		p.mu.Unlock()
		h.Set("Content-Type", "text/html; charset=utf-8")
		_ = pageTmpl.Execute(w, pageData{
			Code:       p.display,
			AppURL:     appURL,
			StatusPath: p.path + "/status",
			Paired:     paired,
		})
	case "status":
		// Long-poll: block until paired (instant flip), the browser gives up, or
		// the server closes. r.Context() is canceled if the tab navigates away.
		h.Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, "{\"paired\":%t}", p.waitPaired(r.Context()))
	default:
		http.NotFound(w, r)
	}
}

// randNonce returns a 256-bit URL-safe single-use path segment (43 base64url
// chars, no padding). 256 bits makes the page path unguessable by any process
// that does not already hold it.
func randNonce() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("agent: pair page nonce: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

// openBrowser opens url in the host's default browser without blocking. On
// headless Linux (no DISPLAY/WAYLAND_DISPLAY) it returns an error immediately so
// the caller falls back to stderr rather than spawning a doomed opener. A nil
// return means the opener launched, NOT that a tab is visibly on screen.
func openBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		//nolint:gosec // G204: url is a self-minted http://127.0.0.1 loopback address, never attacker-controlled.
		return exec.Command("open", url).Start()
	case "windows":
		//nolint:gosec // G204: url is a self-minted http://127.0.0.1 loopback address, never attacker-controlled.
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default: // linux, *bsd
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return fmt.Errorf("agent: no display for browser open")
		}
		//nolint:gosec // G204: url is a self-minted http://127.0.0.1 loopback address, never attacker-controlled.
		return exec.Command("xdg-open", url).Start()
	}
}
