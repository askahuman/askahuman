// Command devproxy is a LOCAL-DEV-ONLY TLS reverse proxy. It fronts the kind
// relay (ws) and the web PWA (http) behind one HTTPS origin so a phone on the LAN
// gets a secure context — required for the in-app camera (getUserMedia), service
// workers, and Web Push. It terminates TLS with an mkcert cert and forwards
// /ws + /healthz to the relay and everything else to the web. WebSocket upgrades
// are handled by net/http/httputil (Upgrade-aware since Go 1.12).
//
// NOT for production — prod TLS is the GKE-managed certificate (infra/prod). ko
// only builds ./cmd/relay, so this never ships in an image.
package main

import (
	"crypto/tls"
	"flag"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
)

func main() {
	addr := flag.String("addr", ":8443", "HTTPS listen address")
	relay := flag.String("relay", "http://127.0.0.1:8080", "relay backend (forwards /ws + /healthz)")
	web := flag.String("web", "http://127.0.0.1:8081", "web backend (forwards everything else)")
	cert := flag.String("cert", "", "TLS cert file (PEM) — required")
	key := flag.String("key", "", "TLS key file (PEM) — required")
	flag.Parse()

	if *cert == "" || *key == "" {
		log.Fatalln("devproxy: --cert and --key are required")
	}

	relayURL, err := url.Parse(*relay)
	if err != nil {
		log.Fatalln("devproxy: bad --relay:", err)
	}
	webURL, err := url.Parse(*web)
	if err != nil {
		log.Fatalln("devproxy: bad --web:", err)
	}
	relayProxy := httputil.NewSingleHostReverseProxy(relayURL)
	webProxy := httputil.NewSingleHostReverseProxy(webURL)

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ws", "/healthz":
			relayProxy.ServeHTTP(w, r)
		default:
			webProxy.ServeHTTP(w, r)
		}
	})

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS12},
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("devproxy: https%s  ->  relay %s (/ws,/healthz)  +  web %s", *addr, *relay, *web)
	log.Fatalln(srv.ListenAndServeTLS(*cert, *key))
}
