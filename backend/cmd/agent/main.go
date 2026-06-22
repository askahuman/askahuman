// Command agent is the MCP agent that asks a human for approval.
//
// Subcommands (stdout is reserved for MCP JSON-RPC; everything human-facing
// goes to stderr):
//
//	serve  run the stdio MCP server exposing the request_approval tool;
//	       pairs on first tool call (or eagerly via start_pairing).
//	pair   print the pairing code to stderr and hold the pairing open
//	       (manual/dev use).
//	ask    one-shot CLI driver for E2E tests: mint a code (room derived from
//	       it), pair as A, send one request, print the decision JSON, exit 0.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	var err error
	switch os.Args[1] {
	case "serve":
		err = runServe(ctx, os.Args[2:])
	case "pair":
		err = runPair(ctx, os.Args[2:])
	case "ask":
		err = runAsk(ctx, os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		log.Fatalf("agent %s: %v", os.Args[1], err)
	}
}

func usage() {
	// stderr only: stdout is reserved for MCP JSON-RPC.
	fmt.Fprintln(os.Stderr, "usage: agent <serve|pair|ask> [flags]")
	fmt.Fprintln(os.Stderr, "  serve  run the stdio MCP server (request_approval tool)")
	fmt.Fprintln(os.Stderr, "  pair   print the pairing code and hold it open")
	fmt.Fprintln(os.Stderr, "  ask    one-shot: pair, send one request, print the decision JSON")
}
