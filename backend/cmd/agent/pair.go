package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/askahuman/askahuman/backend/internal/agent"
)

// defaultRelayURL is a var (not a const) so release builds can bake in the
// hosted endpoint via -ldflags "-X main.defaultRelayURL=...". A plain
// `go build` keeps the localhost dev default. ref. .goreleaser.yaml
var defaultRelayURL = "ws://127.0.0.1:8080/ws"

// runPair prints the pairing code to stderr and holds the pairing open until
// the phone enters the code or ctx is canceled.
func runPair(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("pair", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	relayURL := fs.String("relay", defaultRelayURL, "relay WebSocket URL the agent dials")
	publicRelay := fs.String("public-relay", "", "relay URL the phone dials when it differs from --relay (e.g. wss://<lan>:8443/ws for local HTTPS)")
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
	agent.PrintCode(os.Stderr, p.Display)

	fmt.Fprintln(os.Stderr, "waiting for the phone to enter the code...")
	if err := ag.Pair(ctx, p); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "paired. session key established (held in RAM).")
	<-ctx.Done()
	return nil
}
