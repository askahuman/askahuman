package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/askahuman/askahuman/backend/internal/agent"
)

// defaultRelayURL and defaultWebOrigin are vars (not consts) so release builds
// can bake in the hosted endpoints via -ldflags "-X main.defaultRelayURL=...".
// A plain `go build` keeps the localhost dev defaults. ref. .goreleaser.yaml
var (
	defaultRelayURL  = "ws://127.0.0.1:8080/ws"
	defaultWebOrigin = "http://127.0.0.1:4321"
)

// runPair prints the pairing QR/code/deep-link to stderr and holds the
// pairing open until the phone connects or ctx is canceled.
func runPair(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("pair", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	relayURL := fs.String("relay", defaultRelayURL, "relay WebSocket URL the agent dials")
	publicRelay := fs.String("public-relay", "", "relay URL advertised to the phone (default: --relay; e.g. wss://<lan>:8443/ws for local HTTPS)")
	webOrigin := fs.String("web", defaultWebOrigin, "PWA origin for the deep link")
	if err := fs.Parse(args); err != nil {
		return err
	}

	ag, err := agent.New(agent.Config{RelayURL: *relayURL, PublicRelayURL: *publicRelay})
	if err != nil {
		return err
	}
	p, err := ag.NewPairing()
	if err != nil {
		return err
	}
	agent.PrintPairing(os.Stderr, *webOrigin, p)

	fmt.Fprintln(os.Stderr, "waiting for phone to pair...")
	if err := ag.Pair(ctx, p); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "paired. session key established (held in RAM).")
	<-ctx.Done()
	return nil
}
