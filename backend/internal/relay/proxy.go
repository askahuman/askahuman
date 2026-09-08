package relay

import (
	"errors"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"strings"
)

// Proxy trust requires both an allowlist of direct TCP peers and an exact XFF
// suffix position. A bare AAH_RELAY_TRUST_PROXY=1 is deliberately insufficient.
// The zero value ignores all forwarded headers, including on direct exposure.
type proxyConfig struct {
	trustedPeers    []netip.Prefix
	clientFromRight int
}

var trustedProxy = proxyConfigFromEnv()

func proxyConfigFromEnv() proxyConfig {
	cfg, err := parseProxyConfig(os.Getenv("AAH_RELAY_TRUST_PROXY"),
		os.Getenv("AAH_RELAY_TRUSTED_PROXY_CIDRS"),
		os.Getenv("AAH_RELAY_XFF_CLIENT_FROM_RIGHT"))
	if err != nil {
		// Static configuration only; never log request headers or peer IPs.
		log.Printf("relay: ignoring forwarded headers: %v", err)
	}
	return cfg
}

func parseProxyConfig(enabled, cidrs, position string) (proxyConfig, error) {
	if enabled != "1" {
		return proxyConfig{}, nil
	}
	n, err := strconv.Atoi(position)
	if err != nil || n < 1 || n > 16 {
		return proxyConfig{}, errors.New("AAH_RELAY_XFF_CLIENT_FROM_RIGHT must be between 1 and 16 when proxy trust is enabled")
	}
	cfg := proxyConfig{clientFromRight: n}
	for _, entry := range strings.Split(cidrs, ",") {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(entry))
		if err != nil || prefix.Bits() == 0 {
			return proxyConfig{}, errors.New("AAH_RELAY_TRUSTED_PROXY_CIDRS must contain explicit CIDRs and must not trust all addresses")
		}
		cfg.trustedPeers = append(cfg.trustedPeers, prefix.Masked())
	}
	return cfg, nil
}

// clientIP returns a canonical IP for connection accounting. Only allowlisted
// TCP peers may supply XFF. The configured suffix, including every hop after
// the selected client, must parse exactly; never skip malformed hops into a
// client-controlled prefix. Google L7 appends client,forwarding-rule, so its
// position is 2; a proxy that appends only the observed client uses 1.
func clientIP(req *http.Request) string {
	host := remoteHost(req.RemoteAddr)
	remote, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	remote = remote.Unmap()
	if ip, _ := forwardedIdentity(req, remote); ip.IsValid() {
		return ip.String()
	}
	return remote.String()
}

// forwardedIdentity is the single trust/suffix classifier used by both client
// accounting and the public boolean-only deployment probe. The bool distinguishes
// an allowlisted TCP peer with an invalid suffix from an untrusted direct peer.
func forwardedIdentity(req *http.Request, remote netip.Addr) (netip.Addr, bool) {
	for _, prefix := range trustedProxy.trustedPeers {
		if prefix.Contains(remote) {
			// Header.Get sees only the first field line. Join all lines before
			// counting from the right, matching a proxy's append semantics.
			xff := strings.Join(req.Header.Values("X-Forwarded-For"), ",")
			return xffClientIP(xff, trustedProxy.clientFromRight), true
		}
	}
	return netip.Addr{}, false
}

func xffClientIP(xff string, fromRight int) netip.Addr {
	parts := strings.Split(xff, ",")
	if fromRight < 1 || len(parts) < fromRight {
		return netip.Addr{}
	}
	var client netip.Addr
	for i := len(parts) - fromRight; i < len(parts); i++ {
		ip, err := netip.ParseAddr(strings.TrimSpace(parts[i]))
		if err != nil || ip.Zone() != "" {
			return netip.Addr{}
		}
		if !client.IsValid() {
			client = ip.Unmap()
		}
	}
	return client
}

// remoteHost strips a TCP port; addresses without a port are unchanged.
func remoteHost(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return host
}
