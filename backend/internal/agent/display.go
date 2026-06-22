package agent

import (
	"fmt"
	"io"
)

// appURL is where the human opens the PWA to type the pairing code. It carries
// NO secret: the code is typed, never put in the URL, so it never reaches the
// web origin, a proxy, or an access log.
const appURL = "https://ask-a-human.ai/app"

// PrintCode writes the human-facing pairing instruction for displayCode (the
// grouped "XXXX-XXXX" form) to w. Callers pass os.Stderr in production (stdout
// is reserved for MCP JSON-RPC). This is the ONLY channel the code travels on:
// it is the out-of-band secret and must NEVER appear in an MCP tool result. The
// room id is intentionally not printed — it is derivable from the code, so
// showing it would leak nothing useful and only adds noise.
func PrintCode(w io.Writer, displayCode string) {
	_, _ = fmt.Fprintf(w, "Pairing code: %s\n  → open %s and enter it\n", displayCode, appURL)
}

// PairingStatusText is the non-secret pair_status / start_pairing tool result.
// It NEVER contains the SPAKE2 code, room id, or any pairing secret: those are
// out-of-band material that a prompt-injected model/client could read from the
// MCP transcript and use to pair first. The code is shown only on stderr/log
// (PrintCode). The result is a generic instruction pointing the human at the
// code shown in the agent terminal.
func PairingStatusText() string {
	return "pairing in progress — type the code shown in the agent terminal " +
		"(out-of-band) into the app. The pairing code is intentionally not shown here."
}
