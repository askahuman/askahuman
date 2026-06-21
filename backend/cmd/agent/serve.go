package main

import (
	"context"
	"flag"
	"os"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/askahuman/askahuman/backend/internal/agent"
)

// runServe runs the stdio MCP server exposing request_approval. It pairs
// lazily on the first tool call (printing the QR/code to stderr).
func runServe(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	relayURL := fs.String("relay", defaultRelayURL, "relay WebSocket URL the agent dials")
	publicRelay := fs.String("public-relay", "", "relay URL advertised to the phone (default: --relay; e.g. wss://<lan>:8443/ws for local HTTPS)")
	webOrigin := fs.String("web", defaultWebOrigin, "PWA origin for the deep link")
	agentName := fs.String("name", "", "who is asking (shown on the card)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	ag, err := agent.New(agent.Config{RelayURL: *relayURL, PublicRelayURL: *publicRelay, AgentName: *agentName})
	if err != nil {
		return err
	}
	srv := agent.NewMCPServer(ag, *webOrigin, os.Stderr)
	return srv.Server().Run(ctx, &mcp.StdioTransport{})
}
