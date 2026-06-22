package agent

import (
	"io"
	"net/http"
	"strings"
	"testing"

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

// TestPairPageStatusFlipsOnMarkPaired: the poll endpoint reports false until the
// handshake completes, then true — this is what flips the tab to "connected".
func TestPairPageStatusFlipsOnMarkPaired(t *testing.T) {
	p, err := newPairPage("4F2K-9QHR")
	require.NoError(t, err)
	defer p.close()

	statusURL := p.url + "/status"
	status, body, _ := get(t, statusURL)
	require.Equal(t, http.StatusOK, status)
	assert.JSONEq(t, `{"paired":false}`, body)

	p.markPaired()
	status, body, _ = get(t, statusURL)
	require.Equal(t, http.StatusOK, status)
	assert.JSONEq(t, `{"paired":true}`, body)
}
