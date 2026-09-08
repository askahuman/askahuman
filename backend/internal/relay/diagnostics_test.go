package relay

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/askahuman/askahuman/backend/pkg/buildinfo"
)

func TestProxyHealthUsesAccountingClassifierWithoutIdentityDisclosure(t *testing.T) {
	google, err := parseProxyConfig("1", "35.191.0.0/16,130.211.0.0/22", "2")
	require.NoError(t, err)
	orig := trustedProxy
	t.Cleanup(func() { trustedProxy = orig })
	cases := []struct {
		name, remote, xff, client string
		config                    proxyConfig
		trusted, suffix           bool
	}{
		{"direct ignores spoof", "198.51.100.7:1234", "1.1.1.1, 203.0.113.9", "198.51.100.7", proxyConfig{}, false, false},
		{"untrusted peer", "10.0.0.1:1234", "1.1.1.1, 203.0.113.9", "10.0.0.1", google, false, false},
		{"Google suffix", "35.191.0.1:1234", "198.51.100.7, 203.0.113.9", "198.51.100.7", google, true, true},
		{"prepended garbage", "130.211.0.1:1234", "1.1.1.1, broken, 198.51.100.7, 203.0.113.9", "198.51.100.7", google, true, true},
		{"mapped peer", "[::ffff:35.191.0.1]:1234", "198.51.100.7, 203.0.113.9", "198.51.100.7", google, true, true},
		{"malformed suffix", "35.191.0.1:1234", "198.51.100.7, broken", "35.191.0.1", google, true, false},
		{"missing header", "35.191.0.1:1234", "", "35.191.0.1", google, true, false},
		{"invalid remote", "broken", "198.51.100.7, 203.0.113.9", "broken", google, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			trustedProxy = tc.config
			req := httptest.NewRequest(http.MethodGet, "/healthz/proxy?room=private-room&key=private-key", nil)
			req.RemoteAddr = tc.remote
			req.Header.Set("X-Forwarded-For", tc.xff)
			req.Header.Set("Authorization", "Bearer private-token")
			req.Header.Set("Referer", "https://private.example/secret")
			recorder := httptest.NewRecorder()
			New().Mux().ServeHTTP(recorder, req)
			require.Equal(t, http.StatusOK, recorder.Code)
			require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
			require.Equal(t, "application/json", recorder.Header().Get("Content-Type"))
			require.Equal(t, "nosniff", recorder.Header().Get("X-Content-Type-Options"))
			var actual map[string]bool
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &actual))
			require.Equal(t, map[string]bool{"trusted_proxy": tc.trusted, "valid_suffix": tc.suffix}, actual)
			require.Equal(t, tc.client, clientIP(req), "diagnostics and accounting must agree")
			headers, err := json.Marshal(recorder.Header())
			require.NoError(t, err)
			for _, secret := range []string{"private", tc.remote, tc.xff} {
				if secret != "" {
					require.NotContains(t, recorder.Body.String(), secret)
					require.NotContains(t, string(headers), secret)
				}
			}
		})
	}
}

func TestProxyHealthMethodAndExistingHealthContract(t *testing.T) {
	mux := New().Mux()
	for _, method := range []string{http.MethodPost, http.MethodHead, http.MethodPut} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(method, "/healthz/proxy", nil))
		require.Equal(t, http.StatusMethodNotAllowed, rec.Code)
		require.Equal(t, "GET", rec.Header().Get("Allow"))
		require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
		require.Empty(t, rec.Body.String())
	}
	v, c := buildinfo.Version, buildinfo.Commit
	t.Cleanup(func() { buildinfo.Version, buildinfo.Commit = v, c })
	buildinfo.Version, buildinfo.Commit = "1.2.3", "0123456789012345678901234567890123456789"
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "ok", rec.Body.String(), "load-balancer health body remains compatible")
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	require.Equal(t, buildinfo.Version, rec.Header().Get("X-AAH-Version"))
	require.Equal(t, buildinfo.Commit, rec.Header().Get("X-AAH-Commit"))
}
