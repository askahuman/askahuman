package agent

import (
	"fmt"
	"io"

	qrcode "github.com/skip2/go-qrcode"
)

// PrintPairing renders the QR (as a terminal block), the deep link, and the
// short code to w. Callers pass os.Stderr in production (stdout is reserved
// for MCP JSON-RPC). webOrigin is the PWA origin. The QR encodes the private
// DeepLink (<webOrigin>/app#p=<payload>): the fragment is never sent to the web
// server, so a scanned/clicked link never leaks the SPAKE2 code to the origin
// or any proxy/access-log (ref. ADR 0006). This is the out-of-band channel for
// the secret; it must NOT appear in any MCP tool result.
func PrintPairing(w io.Writer, webOrigin string, p Pairing) {
	link := DeepLink(webOrigin, p.Payload)
	_, _ = fmt.Fprintln(w, "scan to pair (or open the link):")
	// qrcode.Low: bigger modules so a phone camera scans a terminal block.
	// ponytail: Low has the least error-correction headroom; bump to Medium if
	// scans fail on noisy/low-contrast displays.
	if qr, err := qrcode.New(link, qrcode.Low); err == nil {
		_, _ = fmt.Fprint(w, qr.ToSmallString(false))
	}
	_, _ = fmt.Fprintf(w, "\nlink: %s\ncode: %s\nroom: %s\n", link, p.Code, p.RoomID)
}

// DeepLink builds <webOrigin>/app#p=<base64url payload>, the URL whose fragment
// is never sent to the server (private). The PWA (mounted at /app, with the
// marketing landing at /) reads it from location.hash.
// ponytail: iOS Camera drops the URL fragment, so a Camera-app scan of this QR
// lands on the bare /app route and falls into "Show my code" (ref. ADR 0006);
// upgrade path = render an HTTPS landing page that re-attaches #p= client-side,
// keeping the secret out of the query. We deliberately do NOT carry the secret
// in ?p= because the query leaks to history/access-logs/LB/referrer.
func DeepLink(webOrigin, payload string) string {
	return fmt.Sprintf("%s/app#p=%s", webOrigin, payload)
}

// PairingStatusText is the non-secret pair_status tool result. It NEVER
// contains the SPAKE2 code, room id, payload, QR, or deep link: those are
// secret material that a prompt-injected model/client could read from the MCP
// transcript and use to pair first. The QR/code stay out-of-band (stderr + the
// pair log only). The result is a generic instruction to scan the QR shown
// outside the chat.
func PairingStatusText() string {
	return "pairing in progress — scan the QR shown in the agent's terminal/log " +
		"(out-of-band). The pairing code is intentionally not shown here."
}
