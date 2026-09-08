package relay

import (
	"encoding/json"
	"net/http"
	"net/netip"
)

// ProxyHealth exposes no headers, addresses, identities, rooms or counters. It
// lets a release probe verify the actual GFE -> pod path without enabling logs.
func (r *Relay) ProxyHealth(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if req.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	remote, err := netip.ParseAddr(remoteHost(req.RemoteAddr))
	var ip netip.Addr
	var trusted bool
	if err == nil {
		ip, trusted = forwardedIdentity(req, remote.Unmap())
	}
	_ = json.NewEncoder(w).Encode(struct {
		TrustedProxy bool `json:"trusted_proxy"`
		ValidSuffix  bool `json:"valid_suffix"`
	}{TrustedProxy: trusted, ValidSuffix: ip.IsValid()})
}
