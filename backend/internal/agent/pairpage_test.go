package agent

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// get fetches url via a client.Do (not http.Get) so the loopback URL the test
// mints does not trip gosec's variable-URL check, and always closes the body.
func get(t *testing.T, url string) (status int, body string, hdr http.Header) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	require.NoError(t, err)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return resp.StatusCode, string(b), resp.Header
}

// TestPairPageServesCodeAtNonce: the page renders the code in its BODY at the
// nonce path, with the no-store + locked-down-CSP hardening headers.
func TestPairPageServesCodeAtNonce(t *testing.T) {
	p, err := newPairPage("4F2K-9QHR")
	require.NoError(t, err)
	defer p.close()

	status, body, hdr := get(t, p.url)
	require.Equal(t, http.StatusOK, status)
	assert.Contains(t, body, "4F2K-9QHR", "the code must appear in the page body")
	assert.Contains(t, body, "ask-a-human", "page should carry the brand")
	assert.Equal(t, "no-store", hdr.Get("Cache-Control"), "code page must not be cached")
	assert.Contains(t, hdr.Get("Content-Security-Policy"), "default-src 'none'",
		"page must forbid outbound requests")
}

// TestPairPageRejectsWithoutNonce: anything that does not present the exact
// nonce path 404s and NEVER leaks the code — a co-resident port probe learns
// nothing.
func TestPairPageRejectsWithoutNonce(t *testing.T) {
	p, err := newPairPage("4F2K-9QHR")
	require.NoError(t, err)
	defer p.close()

	base := strings.TrimSuffix(p.url, p.path) // http://127.0.0.1:<port>
	for _, path := range []string{"/", "/p/", "/p/not-the-nonce", p.path + "x"} {
		status, body, _ := get(t, base+path)
		assert.Equal(t, http.StatusNotFound, status, "path %q must 404", path)
		assert.NotContains(t, body, "4F2K-9QHR", "no code may leak on path %q", path)
	}
}

// TestPairPageStatusLongPollsUntilPaired: while unpaired, /status holds the
// request open (long-poll) instead of returning promptly; the instant markPaired
// fires, the held request returns paired:true — the wakeup that flips the tab to
// "connected" with no poll lag and no teardown race.
func TestPairPageStatusLongPollsUntilPaired(t *testing.T) {
	p, err := newPairPage("4F2K-9QHR")
	require.NoError(t, err)
	defer p.close()
	statusURL := p.url + "/status"

	// Unpaired: a short-deadline request times out rather than returning false —
	// proof the endpoint is holding the connection open.
	shortCtx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(shortCtx, http.MethodGet, statusURL, nil)
	require.NoError(t, err)
	_, err = http.DefaultClient.Do(req) //nolint:bodyclose // request is canceled by the deadline; there is no body to close.
	require.Error(t, err, "unpaired long-poll must not return promptly")

	// markPaired wakes the held long-poll: this blocking GET returns ~immediately
	// with paired:true.
	go func() { time.Sleep(150 * time.Millisecond); p.markPaired() }()
	start := time.Now()
	status, body, _ := get(t, statusURL)
	require.Equal(t, http.StatusOK, status)
	assert.JSONEq(t, `{"paired":true}`, body)
	assert.Less(t, time.Since(start), statusWait, "must wake on markPaired, not on the long-poll timeout")
}

// TestPairPageStatusImmediateWhenAlreadyPaired: once paired, /status returns true
// without blocking (covers a reload after pairing).
func TestPairPageStatusImmediateWhenAlreadyPaired(t *testing.T) {
	p, err := newPairPage("4F2K-9QHR")
	require.NoError(t, err)
	defer p.close()

	p.markPaired()
	start := time.Now()
	status, body, _ := get(t, p.url+"/status")
	require.Equal(t, http.StatusOK, status)
	assert.JSONEq(t, `{"paired":true}`, body)
	assert.Less(t, time.Since(start), time.Second, "already-paired status must not block")
}
