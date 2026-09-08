package wire

// Protocol v2 uses explicit, length-prefixed signing transcripts. JSON is only
// transport syntax: escaping, key order and omitted zero defaults are never
// inputs to a signature. Keep this file in sync with frontend/lib/protocol.ts.
import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	Protocol             = 2
	MaxPlaintext         = 16 * 1024
	MaxText              = 4096
	MaxSafeInteger int64 = 9007199254740991
	UpgradeMessage       = "approval protocol upgrade required: update the agent and refresh the phone app, then call start_pairing with reset:true and enter the new code"
)

type PairHello struct {
	Protocol int    `json:"protocol"`
	Pake     string `json:"pake"`
	Signer   string `json:"signer"`
}

type Ack struct {
	Kind         MessageKind `json:"kind"`
	Protocol     int         `json:"protocol"`
	Room         string      `json:"room"`
	ID           string      `json:"id"`
	RequestHash  string      `json:"request_hash"`
	DecisionHash string      `json:"decision_hash"`
	Status       string      `json:"status"`
	Sig          string      `json:"sig"`
}

func fields(parts ...string) []byte {
	var b bytes.Buffer
	for _, p := range parts {
		var length [8]byte
		binary.BigEndian.PutUint64(length[:], uint64(len(p)))
		b.Write(length[:])
		b.WriteString(p)
	}
	return b.Bytes()
}

// PairBinding binds both signing identities into the password-authenticated
// transcript, in agent/phone role order. It is included before key derivation.
func PairBinding(room, agentSPKI, phoneSPKI string) []byte {
	return fields("aah:pair:v2", room, agentSPKI, phoneSPKI)
}

func RequestSigningMessage(r Request) []byte {
	parts := []string{
		"aah:request:v2", strconv.Itoa(r.Protocol), r.Room, strconv.FormatInt(r.RequestSeq, 10), r.ID,
		r.Title, string(r.Category), r.Summary, r.Agent, string(r.Response.Kind),
		strconv.Itoa(len(r.Response.Options)),
	}
	parts = append(parts, r.Response.Options...)
	parts = append(parts, r.Response.Placeholder, strconv.Itoa(r.Response.MaxLen),
		strconv.Itoa(r.ExpiresInS), strconv.FormatInt(r.DeadlineMS, 10))
	return fields(parts...)
}

func RequestHash(r Request) string { return Hash(RequestSigningMessage(r)) }

func BoundDecisionSigningMessage(d Decision) []byte {
	value := d.Result.Text
	switch d.ResponseKind {
	case ResponseYesNo:
		value = "0"
		if d.Result.Approved != nil && *d.Result.Approved {
			value = "1"
		}
	case ResponseChoice:
		value = d.Result.Choice
	}
	return fields("aah:decision:v2", strconv.Itoa(d.Protocol), d.Room, d.ID,
		d.RequestHash, string(d.ResponseKind), value)
}

func DecisionHash(d Decision) string { return Hash(BoundDecisionSigningMessage(d)) }
func AckSigningMessage(a Ack) []byte {
	return fields("aah:ack:v2", strconv.Itoa(a.Protocol), a.Room, a.ID, a.RequestHash, a.DecisionHash, a.Status)
}

func PushSigningMessage(p PushSub) []byte {
	return fields("aah:push-sub:v2", strconv.Itoa(p.Protocol), p.Room, strconv.FormatInt(p.PushSeq, 10), p.Subscription.Endpoint,
		p.Subscription.Keys.P256dh, p.Subscription.Keys.Auth)
}

func VAPIDSigningMessage(v VAPIDKey) []byte {
	return fields("aah:vapid:v2", strconv.Itoa(v.Protocol), v.Room, v.PublicKey)
}

func Hash(b []byte) string {
	h := sha256.Sum256(b)
	return base64.StdEncoding.EncodeToString(h[:])
}

func Sign(key *ecdsa.PrivateKey, message []byte) (string, error) {
	if key == nil {
		return "", errors.New(UpgradeMessage)
	}
	h := sha256.Sum256(message)
	r, s, err := ecdsa.Sign(rand.Reader, key, h[:])
	if err != nil {
		return "", err
	}
	var sig [64]byte
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return base64.StdEncoding.EncodeToString(sig[:]), nil
}

func Verify(key *ecdsa.PublicKey, message []byte, signature string) bool {
	if key == nil {
		return false
	}
	sig, err := base64.StdEncoding.Strict().DecodeString(signature)
	if err != nil || len(sig) != 64 || base64.StdEncoding.EncodeToString(sig) != signature {
		return false
	}
	h := sha256.Sum256(message)
	return ecdsa.Verify(key, h[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
}

func ParseSigner(s string) (*ecdsa.PublicKey, error) {
	der, err := base64.StdEncoding.Strict().DecodeString(s)
	if err != nil || len(der) > 256 || base64.StdEncoding.EncodeToString(der) != s {
		return nil, errors.New("invalid signing identity")
	}
	k, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	pub, ok := k.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		return nil, errors.New("signing identity must be P-256")
	}
	canonical, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil || !bytes.Equal(canonical, der) {
		return nil, errors.New("noncanonical signing identity")
	}
	return pub, nil
}

func PublicSigner(key *ecdsa.PrivateKey) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	return base64.StdEncoding.EncodeToString(der), err
}

func EncodeMessage(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	padded := pad(raw)
	if len(padded) > MaxPlaintext {
		return nil, errors.New("wire: encoded message exceeds 16 KiB")
	}
	return padded, nil
}

func scalarBound(s, field string, max int, required bool) error {
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > max || (required && s == "") {
		return fmt.Errorf("wire: %s must contain %d or fewer Unicode scalar values%s", field, max, map[bool]string{true: " and cannot be empty"}[required])
	}
	return nil
}

// ValidateRequestInput is called before pairing or sending. It validates both
// individual fields and worst-case encoded transport size, including metadata.
func ValidateRequestInput(r Request) error {
	for _, f := range []struct {
		s, name  string
		max      int
		required bool
	}{
		{r.ID, "id", 256, true},
		{r.Title, "title", 512, false},
		{r.Summary, "summary", 4096, false},
		{r.Agent, "agent", 256, false},
		{string(r.Category), "category", 256, false},
		{r.Response.Placeholder, "placeholder", 256, false},
	} {
		if err := scalarBound(f.s, f.name, f.max, f.required); err != nil {
			return err
		}
	}
	switch r.Response.Kind {
	case ResponseYesNo:
		if r.Response.Options != nil || r.Response.Placeholder != "" || r.Response.MaxLen != 0 {
			return errors.New("wire: yesno response has irrelevant fields")
		}
	case ResponseChoice:
		if len(r.Response.Options) < 1 || len(r.Response.Options) > 32 || r.Response.Placeholder != "" || r.Response.MaxLen != 0 {
			return errors.New("wire: choice requires 1..32 options and no text fields")
		}
		seen := map[string]bool{}
		for _, option := range r.Response.Options {
			if err := scalarBound(option, "option", 256, true); err != nil {
				return err
			}
			if seen[option] {
				return errors.New("wire: duplicate choice option")
			}
			seen[option] = true
		}
	case ResponseText:
		if r.Response.Options != nil || r.Response.MaxLen < 0 || r.Response.MaxLen > MaxText {
			return errors.New("wire: text max_len must be 0..4096 and options must be absent")
		}
	default:
		return errors.New("wire: invalid response kind")
	}
	if r.ExpiresInS < 0 || r.ExpiresInS > 86400 {
		return errors.New("wire: expires_in_s must be 0..86400")
	}
	// Reserve the longest protocol metadata before a pairing can be started.
	r.Kind = KindRequest
	r.Protocol = Protocol
	r.Room = strings.Repeat("f", 16)
	r.DeadlineMS = MaxSafeInteger
	r.RequestSeq = MaxSafeInteger
	r.Sig = strings.Repeat("A", 88)
	_, err := EncodeMessage(r)
	return err
}

func ValidateRequest(r Request) error {
	if err := scalarBound(r.Sig, "signature", 88, false); err != nil {
		return err
	}
	if r.Kind != KindRequest || r.Protocol != Protocol || !validRoom(r.Room) || r.RequestSeq <= 0 || r.RequestSeq > MaxSafeInteger || r.DeadlineMS < 0 || r.DeadlineMS > MaxSafeInteger {
		return errors.New("wire: invalid request metadata")
	}
	return ValidateRequestInput(r)
}

func validRoom(s string) bool {
	if len(s) != 16 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func ValidHash(s string) bool {
	b, err := base64.StdEncoding.Strict().DecodeString(s)
	return err == nil && len(b) == 32 && base64.StdEncoding.EncodeToString(b) == s
}

func ValidateDecision(d Decision) error {
	if err := scalarBound(d.Sig, "signature", 88, false); err != nil {
		return err
	}
	if d.Kind != KindDecision || d.Protocol != Protocol || !validRoom(d.Room) || !ValidHash(d.RequestHash) {
		return errors.New("wire: invalid decision metadata")
	}
	if err := scalarBound(d.ID, "id", 256, true); err != nil {
		return err
	}
	switch d.ResponseKind {
	case ResponseYesNo:
		if d.Result.Approved == nil || d.Result.Choice != "" || d.Result.Text != "" {
			return errors.New("wire: invalid yesno result")
		}
	case ResponseChoice:
		if d.Result.Approved != nil || d.Result.Text != "" {
			return errors.New("wire: invalid choice result")
		}
		return scalarBound(d.Result.Choice, "choice", 256, true)
	case ResponseText:
		if d.Result.Approved != nil || d.Result.Choice != "" {
			return errors.New("wire: invalid text result")
		}
		return scalarBound(d.Result.Text, "text", MaxText, false)
	default:
		return errors.New("wire: invalid result kind")
	}
	return nil
}

// StrictDecode rejects duplicate/unknown/case-aliased keys, nulls, unsafe or
// noncanonical integers, invalid UTF-8 and unpaired JSON surrogate escapes.
// encoding/json alone replaces invalid scalars and matches keys ignoring case.
func StrictDecode(raw []byte, out any) error {
	if len(raw) > MaxPlaintext || !utf8.Valid(raw) || !validEscapedScalars(raw) {
		return errors.New("wire: invalid JSON size or Unicode")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	v, err := strictValue(d, 0)
	if err != nil {
		return err
	}
	if _, err = d.Token(); !errors.Is(err, io.EOF) {
		return errors.New("wire: trailing JSON value")
	}
	t := reflect.TypeOf(out)
	if t == nil || t.Kind() != reflect.Pointer {
		return errors.New("wire: decoder requires pointer")
	}
	if err := exactFields(v, t.Elem()); err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

func strictValue(d *json.Decoder, depth int) (any, error) {
	if depth > 16 {
		return nil, errors.New("wire: JSON nesting too deep")
	}
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch v := t.(type) {
	case json.Delim:
		if v == '{' {
			m := map[string]any{}
			for d.More() {
				k, err := d.Token()
				if err != nil {
					return nil, err
				}
				key, ok := k.(string)
				if !ok {
					return nil, errors.New("wire: invalid key")
				}
				if _, ok := m[key]; ok {
					return nil, errors.New("wire: duplicate JSON key")
				}
				m[key], err = strictValue(d, depth+1)
				if err != nil {
					return nil, err
				}
			}
			_, err = d.Token()
			return m, err
		}
		if v == '[' {
			var a []any
			for d.More() {
				item, e := strictValue(d, depth+1)
				if e != nil {
					return nil, e
				}
				a = append(a, item)
			}
			_, err = d.Token()
			return a, err
		}
		return nil, errors.New("wire: invalid delimiter")
	case json.Number:
		n, e := strconv.ParseInt(string(v), 10, 64)
		if e != nil || n < -MaxSafeInteger || n > MaxSafeInteger || strconv.FormatInt(n, 10) != string(v) {
			return nil, errors.New("wire: invalid integer")
		}
	case nil:
		return nil, errors.New("wire: null is not permitted")
	}
	return t, nil
}

func exactFields(v any, t reflect.Type) error {
	if t.Kind() == reflect.Pointer {
		return exactFields(v, t.Elem())
	}
	if t.Kind() == reflect.Struct {
		m, ok := v.(map[string]any)
		if !ok {
			return errors.New("wire: expected object")
		}
		allowed := map[string]reflect.Type{}
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			name := strings.Split(f.Tag.Get("json"), ",")[0]
			if name != "" && name != "-" {
				allowed[name] = f.Type
			}
		}
		for k, item := range m {
			ft, ok := allowed[k]
			if !ok {
				return fmt.Errorf("wire: unknown field %q", k)
			}
			if err := exactFields(item, ft); err != nil {
				return err
			}
		}
	}
	if t.Kind() == reflect.Slice {
		if a, ok := v.([]any); ok {
			for _, item := range a {
				if err := exactFields(item, t.Elem()); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func validEscapedScalars(raw []byte) bool {
	for i := 0; i < len(raw); i++ {
		if raw[i] != '"' {
			continue
		}
		i++
		for i < len(raw) && raw[i] != '"' {
			if raw[i] != '\\' {
				i++
				continue
			}
			i++
			if i >= len(raw) {
				return false
			}
			if raw[i] != 'u' {
				i++
				continue
			}
			if i+4 >= len(raw) {
				return false
			}
			n, err := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
			if err != nil {
				return false
			}
			i += 5
			if n >= 0xdc00 && n <= 0xdfff {
				return false
			}
			if n >= 0xd800 && n <= 0xdbff {
				if i+5 >= len(raw) || raw[i] != '\\' || raw[i+1] != 'u' {
					return false
				}
				lo, e := strconv.ParseUint(string(raw[i+2:i+6]), 16, 16)
				if e != nil || lo < 0xdc00 || lo > 0xdfff {
					return false
				}
				i += 6
			}
		}
	}
	return true
}
