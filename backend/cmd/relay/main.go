// Command relay runs the stateless, content-blind WebSocket rendezvous.
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"

	"github.com/askahuman/askahuman/backend/internal/relay"
)

func main() {
	addr := flag.String("addr", ":8080", "address the relay listens on")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	r := relay.New()
	if err := r.Serve(ctx, *addr); err != nil {
		log.Fatalf("relay: %v", err)
	}
}
