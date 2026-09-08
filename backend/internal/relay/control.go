package relay

import (
	"encoding/json"
	"strings"
)

// relaySet reserves the top-level _relay key for server signals, regardless of
// its value or case. Decode only raw field values: malformed application field
// types must never make this control-plane check fail open. A map preserves the
// presence of duplicate keys even if a later value overwrites an earlier one.
// Nested keys and the opaque ciphertext are not interpreted. Non-JSON and
// non-object application frames remain opaque and cannot be parsed as signals
// by either client.
func relaySet(data []byte) bool {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return false
	}
	for key := range fields {
		// Go's envelope decoding is case-insensitive, while JavaScript's is
		// case-sensitive. Reserve every variant to avoid parser disagreement.
		if strings.EqualFold(key, "_relay") {
			return true
		}
	}
	return false
}
