package paircode

import (
	"strings"
	"testing"
)

func TestNewCode(t *testing.T) {
	code, err := NewCode()
	if err != nil {
		t.Fatalf("NewCode: %v", err)
	}
	// Display form: "XXXX-XXXX" (Len symbols + one separator at the midpoint).
	if len(code) != Len+1 {
		t.Fatalf("len(code) = %d, want %d", len(code), Len+1)
	}
	if code[Len/2] != '-' {
		t.Fatalf("separator not at midpoint: %q", code)
	}
	for i, c := range code {
		if i == Len/2 {
			continue
		}
		if !strings.ContainsRune(Alphabet, c) {
			t.Fatalf("symbol %q not from Alphabet", string(c))
		}
	}
	// A minted code must round-trip through Canonicalize to exactly Len symbols.
	canon, err := Canonicalize(code)
	if err != nil {
		t.Fatalf("Canonicalize(%q): %v", code, err)
	}
	if len(canon) != Len {
		t.Fatalf("canon len = %d, want %d", len(canon), Len)
	}
}

func TestCanonicalize(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{"already canonical", "4F2K9QHRXY", "4F2K9QHRXY", false},
		{"lowercase + hyphen", "4f2k9-qhrxy", "4F2K9QHRXY", false},
		{"spaces around groups", " 4f2k9 qhrxy ", "4F2K9QHRXY", false},
		{"old 8-symbol code too short", "4F2K9QHR", "", true},
		{"ambiguous char dropped -> short", "4F2K9QHRX0", "", true}, // 0 not in alphabet
		{"too long", "4F2K9QHRXYZ", "", true},
		{"empty", "", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Canonicalize(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("Canonicalize(%q) = %q, want error", tc.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("Canonicalize(%q) unexpected error: %v", tc.in, err)
			}
			if got != tc.want {
				t.Fatalf("Canonicalize(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestRoomFromCode(t *testing.T) {
	canon, err := Canonicalize("4f2k9-qhrxy")
	if err != nil {
		t.Fatal(err)
	}
	room, err := RoomFromCode(canon)
	if err != nil {
		t.Fatal(err)
	}
	if len(room) != 16 {
		t.Fatalf("room id len = %d, want 16 hex chars", len(room))
	}
	for _, r := range room {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			t.Fatalf("room id %q is not lowercase hex", room)
		}
	}
	// Deterministic: same canonical code -> same room.
	again, _ := RoomFromCode(canon)
	if again != room {
		t.Fatalf("RoomFromCode not deterministic: %q vs %q", room, again)
	}
	// Distinct codes -> distinct rooms (preimage/spread sanity).
	other, _ := RoomFromCode("ABCDEFGHJK")
	if other == room {
		t.Fatalf("distinct codes collided on room %q", room)
	}
}
