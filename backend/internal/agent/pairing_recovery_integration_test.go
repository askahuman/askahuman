//go:build integration

package agent

import (
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/askahuman/askahuman/backend/pkg/paircode"
	"github.com/askahuman/askahuman/backend/pkg/sealedbox"
	"github.com/askahuman/askahuman/backend/pkg/wire"
)

// Runs real MCP calls, relay sockets, two fresh SPAKE2 handshakes, and device
// signatures. The forgotten phone's session and signer cannot authorize the new
// pairing even when its old signatures are re-encrypted with the new session key.
func TestIntegrationMCPRepairsForgottenPhonePairing(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	relayURL := startRelay(t)
	ag, err := New(Config{RelayURL: relayURL})
	require.NoError(t, err)
	defer ag.Close()
	h := NewMCPServer(ag, io.Discard)
	codes := make(chan string, 2)
	h.surface = func(display string) (*pairPage, error) { codes <- display; return nil, nil }
	st, ct := mcp.NewInMemoryTransports()
	server, err := h.Server().Connect(ctx, st, nil)
	require.NoError(t, err)
	defer server.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "recovery-test", Version: "v0"}, nil)
	cs, err := client.Connect(ctx, ct, nil)
	require.NoError(t, err)
	defer cs.Close()

	start := func(reset bool) (*phoneStub, string, string) {
		t.Helper()
		args := map[string]any{}
		if reset {
			args["reset"] = true
		}
		res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "start_pairing", Arguments: args})
		require.NoError(t, err)
		require.False(t, res.IsError)
		var display string
		select {
		case display = <-codes:
		case <-ctx.Done():
			t.Fatal("pairing did not surface a new code")
		}
		canon, err := paircode.Canonicalize(display)
		require.NoError(t, err)
		room, err := paircode.RoomFromCode(canon)
		require.NoError(t, err)
		out, err := json.Marshal(res)
		require.NoError(t, err)
		assert.NotContains(t, string(out), display)
		assert.NotContains(t, string(out), canon)
		assert.NotContains(t, string(out), room)
		phone, err := dialPhone(ctx, relayURL, room, canon)
		require.NoError(t, err)
		require.NoError(t, phone.pair(ctx))
		require.NoError(t, h.ensurePaired(ctx))
		return phone, room, display
	}
	send := func(phone *phoneStub, key []byte, value any) {
		t.Helper()
		plain, err := json.Marshal(value)
		require.NoError(t, err)
		box, err := sealedbox.Seal(key, plain)
		require.NoError(t, err)
		require.NoError(t, phone.write(ctx, envelope{Box: box}))
	}
	answer := func(phone *phoneStub, room string, signer deviceSigner, oldSigner *deviceSigner, oldKey []byte) {
		t.Helper()
		type reply struct {
			result *mcp.CallToolResult
			err    error
		}
		result := make(chan reply, 1)
		go func() {
			res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "request_approval", Arguments: map[string]any{
				"title": "Recovery test", "summary": "Decline this harmless test", "response_kind": "yesno", "expires_in_s": 10,
			}})
			result <- reply{res, err}
		}()
		var request wire.Request
		for request.Kind != wire.KindRequest {
			env, err := phone.read(ctx)
			require.NoError(t, err)
			if env.Box == "" {
				continue
			}
			plain, err := sealedbox.Open(phone.key, env.Box)
			require.NoError(t, err)
			require.NoError(t, json.Unmarshal(plain, &request))
		}
		if oldSigner != nil {
			forged := wire.Decision{Kind: wire.KindDecision, ID: request.ID, Result: wire.Result{Approved: boolPtr(true)}}
			forged.Sig = oldSigner.sign(t, room, forged)
			send(phone, oldKey, forged)    // abandoned session key cannot decrypt.
			send(phone, phone.key, forged) // abandoned device pin cannot authorize.
		}
		decline := wire.Decision{Kind: wire.KindDecision, ID: request.ID, Result: wire.Result{Approved: boolPtr(false)}}
		decline.Sig = signer.sign(t, room, decline)
		send(phone, phone.key, decline)
		got := <-result
		require.NoError(t, got.err)
		require.False(t, got.result.IsError)
		out, ok := got.result.StructuredContent.(map[string]any)
		require.True(t, ok)
		assert.Equal(t, false, out["approved"], "only the current device's decline may be returned")
	}

	first, firstRoom, firstCode := start(false)
	defer first.conn.CloseNow()
	firstSigner := newDeviceSigner(t)
	send(first, first.key, firstSigner.deviceKeyFrame())
	answer(first, firstRoom, firstSigner, nil, nil)
	first.conn.CloseNow() // the phone has forgotten/closed its old agent entry.
	require.Eventually(t, func() bool { return !ag.peerPresent.Load() }, time.Second, time.Millisecond)
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "start_pairing", Arguments: map[string]any{}})
	require.NoError(t, err)
	require.False(t, res.IsError)
	assert.Contains(t, pairStatusText(t, h), "offline")
	select {
	case <-codes:
		t.Fatal("ordinary start_pairing replaced the established session")
	default:
	}

	second, secondRoom, secondCode := start(true)
	defer second.conn.CloseNow()
	assert.NotEqual(t, firstCode, secondCode)
	assert.NotEqual(t, firstRoom, secondRoom)
	assert.NotEqual(t, first.key, second.key)
	secondSigner := newDeviceSigner(t)
	send(second, second.key, secondSigner.deviceKeyFrame())
	answer(second, secondRoom, secondSigner, &firstSigner, first.key)
}
