package main

import (
	"context"
	"flag"
	"os"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/askahuman/askahuman/backend/internal/agent"
)

// runServe runs the stdio MCP server exposing request_approval. It pairs
// lazily on the first tool call (printing the pairing code to stderr).
func runServe(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	relayURL := fs.String("relay", defaultRelayURL, "relay WebSocket URL the agent dials")
	publicRelay := fs.String("public-relay", "", "relay URL the phone dials when it differs from --relay (e.g. wss://<lan>:8443/ws for local HTTPS)")
	agentName := fs.String("name", "", "who is asking (shown on the card)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	ag, err := agent.New(agent.Config{RelayURL: *relayURL, PublicRelayURL: *publicRelay, AgentName: *agentName})
	if err != nil {
		return err
	}
	srv := agent.NewMCPServer(ag, os.Stderr)
	return srv.Server().Run(ctx, &mcp.StdioTransport{})
}
