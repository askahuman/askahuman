package relay

import (
	"encoding/json"
	"strings"
)

// relaySet reports reserved control keys OR an unclassifiable client envelope.
// The top-level _relay key is reserved regardless of its value or case.
// Decode only raw field values: malformed application field
// types must never make this control-plane check fail open. A map preserves the
// presence of duplicate keys even if a later value overwrites an earlier one.
// Nested keys and the opaque ciphertext are not interpreted. Classification
// failure is rejected: Go's JSON depth limit is stricter than JavaScript's, so
// an object Go cannot parse may still be a valid control frame to the phone.
// Client frames must be JSON objects within this parser's limits.
func relaySet(data []byte) bool {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return true
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
