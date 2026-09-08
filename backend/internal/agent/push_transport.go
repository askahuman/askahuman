package agent

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

var (
	errPushEndpoint = errors.New("endpoint must use a supported provider over HTTPS on port 443, without credentials or a fragment")
	errPushAddress  = errors.New("provider did not resolve exclusively to public addresses")
	errPushConnect  = errors.New("provider connection failed")
	errPushHTTP     = errors.New("provider request failed")
)

// Paths and queries are opaque push capabilities, not user-facing URLs. Do not
// inspect, rewrite or include them in errors. Provider suffixes are a DNS-label
// boundary, never a substring match; arbitrary/self-hosted push is unsupported.
func validatePushEndpoint(endpoint string) error {
	if len(endpoint) == 0 || len(endpoint) > 8192 || strings.Contains(endpoint, "#") {
		return errPushEndpoint
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Opaque != "" || u.User != nil || u.Host == "" {
		return errPushEndpoint
	}
	host := u.Hostname()
	if !supportedPushHost(host) || (u.Port() != "" && u.Port() != "443") {
		return errPushEndpoint
	}
	// Reject empty/ambiguous ports and alternate authority encodings. DNS names
	// are ASCII; trailing dots and IDNA lookalikes cannot broaden the allowlist.
	if u.Host != host && u.Host != host+":443" {
		return errPushEndpoint
	}
	return nil
}

func supportedPushHost(host string) bool {
	if len(host) == 0 || len(host) > 253 {
		return false
	}
	for i := range len(host) {
		if host[i] > 127 {
			return false
		}
	}
	host = strings.ToLower(host)
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, ch := range label {
			if (ch < 'a' || ch > 'z') && (ch < '0' || ch > '9') && ch != '-' {
				return false
			}
		}
	}
	return host == "fcm.googleapis.com" || host == "updates.push.services.mozilla.com" ||
		strings.HasSuffix(host, ".push.apple.com") || strings.HasSuffix(host, ".notify.windows.com")
}

type (
	pushLookup func(context.Context, string, string) ([]netip.Addr, error)
	pushDial   func(context.Context, string, string) (net.Conn, error)
)

// pushDialer resolves once per connection, validates the entire answer set,
// then dials a literal IP. The net.Dialer must never resolve the hostname again:
// validating one answer and dialing the name would permit DNS rebinding.
type pushDialer struct {
	lookup pushLookup
	dial   pushDial
}

func (d pushDialer) dialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || network != "tcp" || port != "443" || !supportedPushHost(host) {
		return nil, errPushEndpoint
	}
	ips, err := d.lookup(ctx, "ip", host)
	if err != nil || len(ips) == 0 || len(ips) > 32 {
		return nil, pushContextError(ctx, errPushAddress)
	}
	for _, ip := range ips {
		if !publicPushIP(ip) {
			return nil, errPushAddress
		}
	}
	for _, ip := range ips {
		conn, err := d.dial(ctx, network, net.JoinHostPort(ip.Unmap().String(), port))
		if err == nil {
			return conn, nil
		}
		if ctx.Err() != nil {
			break
		}
	}
	return nil, pushContextError(ctx, errPushConnect)
}

// Conservative special-purpose exclusions, in addition to the standard private,
// loopback and link-local checks. These provider APIs have no reason to use IANA
// special-purpose, documentation, translation, transition or multicast ranges.
// IPv6 is restricted to allocated global unicast space (2000::/3).
// Sources: IANA IPv4 and IPv6 Special-Purpose Address Registries; see SECURITY.md.
var pushSpecialPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.31.196.0/24"),
	netip.MustParsePrefix("192.52.193.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("192.175.48.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("2620:4f:8000::/48"),
	netip.MustParsePrefix("3fff::/20"),
}

var pushIPv6Global = netip.MustParsePrefix("2000::/3")

func publicPushIP(ip netip.Addr) bool {
	if !ip.IsValid() || ip.Zone() != "" {
		return false
	}
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	if ip.Is6() && !pushIPv6Global.Contains(ip) {
		return false
	}
	for _, prefix := range pushSpecialPrefixes {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}

// restrictedPushClient checks the URL on every request even if a connection is
// reused. Its transport does not inherit global/environment proxy settings, and
// redirects are never followed (including redirects to another allowed host).
type restrictedPushClient struct {
	client *http.Client
}

var defaultPushHTTPClient = newPushHTTPClient(pushDialer{
	lookup: net.DefaultResolver.LookupNetIP,
	dial:   (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
})

func newPushHTTPClient(d pushDialer) *restrictedPushClient {
	return &restrictedPushClient{client: &http.Client{
		Timeout: pushWakeTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{
			Proxy:                  nil,
			DialContext:            d.dialContext,
			ForceAttemptHTTP2:      true,
			TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
			TLSHandshakeTimeout:    5 * time.Second,
			ResponseHeaderTimeout:  5 * time.Second,
			MaxResponseHeaderBytes: 16 << 10,
			MaxIdleConns:           16,
			MaxIdleConnsPerHost:    2,
			MaxConnsPerHost:        4,
			IdleConnTimeout:        30 * time.Second,
			DisableCompression:     true,
		},
	}}
}

func (c *restrictedPushClient) Do(req *http.Request) (*http.Response, error) {
	if req == nil || req.URL == nil {
		return nil, errPushEndpoint
	}
	if err := validatePushEndpoint(req.URL.String()); err != nil {
		return nil, err
	}
	if req.Method != http.MethodPost || (req.Host != "" && req.Host != req.URL.Host) {
		return nil, errPushEndpoint
	}
	resp, err := c.client.Do(req) // #nosec G704 -- URL allowlisted above; transport pins public IPs and disables proxies and redirects.
	if err != nil {
		// net/http wraps errors with the complete URL (and may include a bad
		// Location header). Never let an opaque subscription token reach logs.
		return nil, pushContextError(req.Context(), errPushHTTP)
	}
	return resp, nil
}

func pushContextError(ctx context.Context, fallback error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return fallback
}
