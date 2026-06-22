package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/askahuman/askahuman/backend/internal/agent"
	"github.com/askahuman/askahuman/backend/pkg/wire"
)

// runAsk is the one-shot E2E driver: mint a code (room derived from it), print
// the code (for the harness/PWA), pair as A, send one request, print the
// decision as JSON to stdout, exit 0. Phase-3 Playwright scripts this.
func runAsk(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("ask", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	relayURL := fs.String("relay", defaultRelayURL, "relay WebSocket URL the agent dials")
	publicRelay := fs.String("public-relay", "", "relay URL the phone dials when it differs from --relay (e.g. wss://<lan>:8443/ws for local HTTPS)")
	kind := fs.String("kind", "yesno", "response kind: yesno|choice|text")
	title := fs.String("title", "Approval request", "request title")
	summary := fs.String("summary", "", "request summary/body")
	category := fs.String("category", string(wire.CategoryOther), "category badge")
	options := fs.String("options", "", "choice options (csv, for --kind choice)")
	placeholder := fs.String("placeholder", "", "text input placeholder (for --kind text)")
	maxLen := fs.Int("max-len", 0, "text input max length (for --kind text)")
	expires := fs.Int("expires", 300, "expiry in seconds")
	printPair := fs.Bool("print-pair", false, "print the pairing code + derived room to stderr (for the test harness)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	rk := wire.ResponseKind(*kind)
	if !wire.ValidResponseKind(rk) {
		return fmt.Errorf("invalid --kind %q (want yesno|choice|text)", *kind)
	}

	ag, err := agent.New(agent.Config{RelayURL: *relayURL, PublicRelayURL: *publicRelay})
	if err != nil {
		return err
	}
	p, err := ag.NewPairing()
	if err != nil {
		return err
	}
	if *printPair {
		// Machine-readable pair line for the test harness. The room is derived
		// from the code; no deep link / payload exists anymore. The harness types
		// the code into the PWA, which derives the same room.
		fmt.Fprintf(os.Stderr, "PAIR code=%s room=%s relay=%s\n", p.Display, p.RoomID, *relayURL)
	}
	agent.PrintCode(os.Stderr, p.Display)

	if err := ag.Pair(ctx, p); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "paired; sending request...")

	reqID, err := agent.NewReqID()
	if err != nil {
		return err
	}
	req := wire.Request{
		ID:         reqID,
		Title:      *title,
		Category:   wire.Category(*category),
		Summary:    *summary,
		Response:   buildResponse(rk, *options, *placeholder, *maxLen),
		ExpiresInS: *expires,
	}

	dec, err := ag.Ask(ctx, req)
	if err != nil {
		return err
	}

	out, err := json.Marshal(dec)
	if err != nil {
		return err
	}
	// stdout: the decision JSON is the one-shot's machine-readable result.
	fmt.Fprintln(os.Stdout, string(out))
	return nil
}

// buildResponse assembles the Response for the chosen kind.
func buildResponse(rk wire.ResponseKind, options, placeholder string, maxLen int) wire.Response {
	r := wire.Response{Kind: rk}
	switch rk {
	case wire.ResponseChoice:
		for _, o := range strings.Split(options, ",") {
			o = strings.TrimSpace(o)
			if o != "" {
				r.Options = append(r.Options, o)
			}
		}
	case wire.ResponseText:
		r.Placeholder = placeholder
		r.MaxLen = maxLen
	}
	return r
}
