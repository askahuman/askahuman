package relay

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/askahuman/askahuman/backend/pkg/wire"
)

func TestClientIPExtraction(t *testing.T) {
	google, err := parseProxyConfig("1", "35.191.0.0/16,130.211.0.0/22,2600:2d00:1:1::/64", "2")
	require.NoError(t, err)
	oneHop, err := parseProxyConfig("1", "10.0.0.1/32", "1")
	require.NoError(t, err)
	cases := []struct {
		name   string
		proxy  proxyConfig
		remote string
		xff    []string
		want   string
	}{
		{"direct ignores absent XFF", proxyConfig{}, "198.51.100.7:1234", nil, "198.51.100.7"},
		{"direct ignores Google-like XFF", proxyConfig{}, "198.51.100.7:1234", []string{"1.1.1.1, 203.0.113.9"}, "198.51.100.7"},
		{"non-proxy TCP peer cannot spoof", google, "198.51.100.7:1234", []string{"1.1.1.1, 203.0.113.9"}, "198.51.100.7"},
		{"untrusted pod cannot spoof", google, "10.0.0.1:1234", []string{"1.1.1.1, 203.0.113.9"}, "10.0.0.1"},
		{"Google selects client not forwarding rule", google, "35.191.0.1:1234", []string{"198.51.100.7, 203.0.113.9"}, "198.51.100.7"},
		{"Google ignores spoofed prefix", google, "130.211.0.1:1234", []string{"1.1.1.1, 8.8.8.8, 198.51.100.7, 203.0.113.9"}, "198.51.100.7"},
		{"Google ignores invalid prefix", google, "35.191.0.1:1234", []string{"garbage, , 198.51.100.7, 203.0.113.9"}, "198.51.100.7"},
		{"all header field lines counted", google, "35.191.0.1:1234", []string{"1.1.1.1, 2.2.2.2", "198.51.100.7, 203.0.113.9"}, "198.51.100.7"},
		{"does not skip malformed last hop", google, "35.191.0.1:1234", []string{"1.1.1.1, 198.51.100.7, broken"}, "35.191.0.1"},
		{"does not skip malformed client", google, "35.191.0.1:1234", []string{"1.1.1.1, broken, 203.0.113.9"}, "35.191.0.1"},
		{"missing suffix fails closed", google, "35.191.0.1:1234", []string{"198.51.100.7"}, "35.191.0.1"},
		{"missing header fails closed", google, "35.191.0.1:1234", nil, "35.191.0.1"},
		{"empty suffix fails closed", google, "35.191.0.1:1234", []string{"198.51.100.7, "}, "35.191.0.1"},
		{"ports rejected in XFF", google, "35.191.0.1:1234", []string{"198.51.100.7:1234, 203.0.113.9"}, "35.191.0.1"},
		{"zones rejected in XFF", google, "35.191.0.1:1234", []string{"fe80::1%en0, 203.0.113.9"}, "35.191.0.1"},
		{"trim whitespace", google, "35.191.0.1:1234", []string{" 198.51.100.7 , 203.0.113.9 "}, "198.51.100.7"},
		{"IPv6 canonical client", google, "[2600:2d00:1:1::1]:1234", []string{"2001:0db8:0:0:0:0:0:7, 203.0.113.9"}, "2001:db8::7"},
		{"mapped IPv4 canonical client", google, "35.191.0.1:1234", []string{"::ffff:198.51.100.7, 203.0.113.9"}, "198.51.100.7"},
		{"mapped IPv4 TCP peer", google, "[::ffff:35.191.0.1]:1234", []string{"198.51.100.7, 203.0.113.9"}, "198.51.100.7"},
		{"single-hop proxy selects rightmost", oneHop, "10.0.0.1:1234", []string{"1.1.1.1, 198.51.100.7"}, "198.51.100.7"},
		{"single-hop malformed suffix fails closed", oneHop, "10.0.0.1:1234", []string{"1.1.1.1, broken"}, "10.0.0.1"},
		{"direct remote without port", proxyConfig{}, "198.51.100.7", nil, "198.51.100.7"},
	}
	orig := trustedProxy
	t.Cleanup(func() { trustedProxy = orig })
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			trustedProxy = tc.proxy
			req := &http.Request{RemoteAddr: tc.remote, Header: http.Header{}}
			for _, field := range tc.xff {
				req.Header.Add("X-Forwarded-For", field)
			}
			assert.Equal(t, tc.want, clientIP(req))
		})
	}
}

func TestProxyConfigRequiresExplicitTrust(t *testing.T) {
	cases := []struct {
		name, enabled, cidrs, position string
		wantErr                        bool
		wantPosition                   int
	}{
		{"disabled", "", "", "", false, 0},
		{"disabled ignores settings", "0", "bad", "bad", false, 0},
		{"bare switch is insufficient", "1", "", "", true, 0},
		{"no allowlist", "1", "", "2", true, 0},
		{"malformed CIDR", "1", "35.191.0.0/16,bad", "2", true, 0},
		{"empty CIDR", "1", "35.191.0.0/16,", "2", true, 0},
		{"universal IPv4 trust forbidden", "1", "0.0.0.0/0", "2", true, 0},
		{"universal IPv6 trust forbidden", "1", "::/0", "2", true, 0},
		{"zero position", "1", "35.191.0.0/16", "0", true, 0},
		{"negative position", "1", "35.191.0.0/16", "-1", true, 0},
		{"unbounded position", "1", "35.191.0.0/16", "17", true, 0},
		{"valid Google config", "1", "35.191.0.0/16,130.211.0.0/22", "2", false, 2},
		{"single trusted proxy", "1", "10.0.0.1/32", "1", false, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := parseProxyConfig(tc.enabled, tc.cidrs, tc.position)
			assert.Equal(t, tc.wantErr, err != nil)
			assert.Equal(t, tc.wantPosition, cfg.clientFromRight)
			if tc.wantPosition == 0 {
				assert.Empty(t, cfg.trustedPeers, "invalid configuration must disable all trust")
			}
		})
	}
}

func TestDefaultCapacitySupportsHundredPairsBehindOneNAT(t *testing.T) {
	orig := maxConnsPerIP
	maxConnsPerIP = defaultMaxConnsPerIP
	t.Cleanup(func() { maxConnsPerIP = orig })
	base := newServer(t)
	// Every dial comes from loopback: both ends of all 100 rooms share one IP.
	for i := 0; i < 100; i++ {
		room := fmt.Sprintf("%016x", i)
		a := dialRoom(t, base, room)
		t.Cleanup(func() { a.CloseNow() })
		b := dialRoom(t, base, room)
		t.Cleanup(func() { b.CloseNow() })
		require.Equal(t, wire.SignalPeerJoined, readFrame(t, a).Relay)
		require.Equal(t, wire.SignalPeerJoined, readFrame(t, b).Relay)
		writeText(t, a, `{"box":"opaque"}`)
		require.Equal(t, "opaque", readFrame(t, b).Box)
	}
}

func TestDefaultCapacityRemainsBoundedAndReleasesSlots(t *testing.T) {
	orig := maxConnsPerIP
	maxConnsPerIP = defaultMaxConnsPerIP
	t.Cleanup(func() { maxConnsPerIP = orig })
	r := New()
	for i := 0; i < defaultMaxConnsPerIP; i++ {
		require.True(t, r.reserveIP("198.51.100.7"))
	}
	require.False(t, r.reserveIP("198.51.100.7"))
	require.True(t, r.reserveIP("198.51.100.8"), "different clients retain independent capacity")
	r.releaseIP("198.51.100.7")
	require.True(t, r.reserveIP("198.51.100.7"))
}

func TestCapacityOverrideFallsBackToSafeDefault(t *testing.T) {
	for _, value := range []string{"", "invalid", "0", "-1"} {
		t.Setenv("AAH_RELAY_MAX_CONNS_PER_IP", value)
		require.Equal(t, 256, envInt("AAH_RELAY_MAX_CONNS_PER_IP", defaultMaxConnsPerIP))
	}
	t.Setenv("AAH_RELAY_MAX_CONNS_PER_IP", "300")
	require.Equal(t, 300, envInt("AAH_RELAY_MAX_CONNS_PER_IP", defaultMaxConnsPerIP))
}
