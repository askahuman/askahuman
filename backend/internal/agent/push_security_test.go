package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/askahuman/askahuman/backend/pkg/wire"
)

// Reproduces R06 with a real loopback server and valid Web Push key material.
// Both admission and the final send boundary must reject an unsafe endpoint.
func TestPushRejectsLoopbackEndpoint(t *testing.T) {
	var posts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	priv, pub, err := webpush.GenerateVAPIDKeys()
	require.NoError(t, err)
	sub := wire.PushSubscription{Endpoint: srv.URL + "/internal-admin", Keys: wire.PushKeys{P256dh: testP256dh, Auth: testAuth}}
	phone := newDeviceSigner(t)
	ps := wire.PushSub{Kind: wire.KindPushSub, Protocol: wire.Protocol, PushSeq: 1, Room: testRoom, Subscription: sub}
	ps.Sig, err = wire.Sign(phone.priv, wire.PushSigningMessage(ps))
	require.NoError(t, err)
	raw, err := json.Marshal(ps)
	require.NoError(t, err)
	a := &Agent{vapidPriv: priv, vapidPub: pub, vapidSub: defaultVAPIDSubject, sess: &Session{protocol: wire.Protocol, roomID: testRoom, devicePub: &phone.priv.PublicKey}}
	a.absorbPush(raw)
	err = a.Notify(context.Background())
	require.Zero(t, posts.Load(), "an authenticated subscription must not cause a POST to loopback; Notify: %v", err)
	require.Nil(t, a.sub, "unsafe subscription must not be stored")
	// Even a stale/directly seeded subscription cannot bypass send validation.
	a.sub = &webpush.Subscription{Endpoint: sub.Endpoint, Keys: webpush.Keys{P256dh: testP256dh, Auth: testAuth}}
	require.Error(t, a.Notify(context.Background()))
	require.Zero(t, posts.Load())
}

func TestPushEndpointProviderPolicy(t *testing.T) {
	valid := []string{
		"https://web.push.apple.com/Q-test-capability",
		"https://future.region.push.apple.com/opaque?token=a%2Fb%3D",
		"https://fcm.googleapis.com/fcm/send/opaque",
		"https://fcm.googleapis.com/wp/opaque",
		"https://updates.push.services.mozilla.com/wpush/v2/opaque",
		"https://wns2-am3p.notify.windows.com/w/?token=opaque%2Fvalue",
		"https://WEB.PUSH.APPLE.COM:443/opaque",
	}
	invalid := []string{
		"", "http://web.push.apple.com/token", "//web.push.apple.com/token", "file:///etc/passwd",
		"https://127.0.0.1/token", "https://2130706433/token", "https://0x7f000001/token",
		"https://[::1]/token", "https://[::ffff:127.0.0.1]/token", "https://localhost/token",
		"https://169.254.169.254/latest/meta-data/", "https://private.example/push",
		"https://web.push.apple.com:80/token", "https://web.push.apple.com:8443/token",
		"https://web.push.apple.com:/token", "https://web.push.apple.com:0443/token",
		"https://web.push.apple.com:bad/token", "https://web.push.apple.com:443:443/token",
		"https://user:password@web.push.apple.com/token", "https://@web.push.apple.com/token",
		"https://web.push.apple.com@evil.example/token", "https://web.push.apple.com/token#fragment",
		"https://web.push.apple.com/token#", "https://web.push.apple.com./token",
		"https://web.push.apple.com.evil.example/token", "https://evilpush.apple.com/token",
		"https://push.apple.com/token", "https://.push.apple.com/token", "https://a..push.apple.com/token",
		"https://-a.push.apple.com/token", "https://a-.push.apple.com/token",
		"https://fcm.googleapis.com.evil/token", "https://evil.fcm.googleapis.com/token",
		"https://evilupdates.push.services.mozilla.com/token", "https://notify.windows.com/token",
		"https://evilnotify.windows.com/token", "https://wns.notify.windows.com.evil/token",
		"https://web.push.аpple.com/token", // Cyrillic a; do not IDNA-fold a lookalike.
		"https://xn--pple-43d.push.apple.com./token", "https://web.push.xn--pple-43d.com/token", "https://K.push.apple.com/token",
		"https://web%2Epush.apple.com/token", "https://web.push.apple.com\\@127.0.0.1/token",
		"https://web.push.apple.com/\nsecret", "https:web.push.apple.com/token",
		"https://web.push.apple.com/" + strings.Repeat("a", 8192),
	}
	for _, endpoint := range valid {
		require.NoError(t, validatePushEndpoint(endpoint), endpoint)
	}
	for _, endpoint := range invalid {
		require.ErrorIs(t, validatePushEndpoint(endpoint), errPushEndpoint, endpoint)
	}
}

func TestPushInvalidUpdatePreservesWorkingSubscription(t *testing.T) {
	phone := newDeviceSigner(t)
	a := &Agent{sess: &Session{protocol: wire.Protocol, roomID: testRoom, devicePub: &phone.priv.PublicKey}}
	var sequence int64
	accept := func(endpoint string) {
		t.Helper()
		sequence++
		ps := wire.PushSub{Kind: wire.KindPushSub, Protocol: wire.Protocol, PushSeq: sequence, Room: testRoom, Subscription: wire.PushSubscription{Endpoint: endpoint}}
		var err error
		ps.Sig, err = wire.Sign(phone.priv, wire.PushSigningMessage(ps))
		require.NoError(t, err)
		raw, err := json.Marshal(ps)
		require.NoError(t, err)
		require.True(t, a.absorbPush(raw))
	}
	accept("https://web.push.apple.com/working")
	working := a.sub
	require.NotNil(t, working)
	for _, endpoint := range []string{"", "http://127.0.0.1/", "https://unknown.example/push"} {
		accept(endpoint)
		require.Same(t, working, a.sub)
	}
}

func TestPushSpecialAddressesRejectedBeforeDial(t *testing.T) {
	blocked := []string{
		"0.0.0.0", "0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.254", "127.0.0.2",
		"169.254.169.254", "172.16.0.1", "172.31.255.254", "192.0.0.9", "192.0.2.1",
		"192.31.196.1", "192.52.193.1", "192.88.99.1", "192.168.1.1", "192.175.48.1",
		"198.18.0.1", "198.19.255.254", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
		"::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
		"::ffff:100.64.0.1", "::ffff:192.0.2.1", "64:ff9b::7f00:1", "64:ff9b:1::1",
		"100::1", "100:0:0:1::1", "2001::1", "2001:2::1", "2001:db8::1", "2002:7f00:1::1",
		"2620:4f:8000::1", "3fff::1", "5f00::1", "fc00::1", "fd00::1", "fe80::1", "fe80::1%en0", "ff02::1",
	}
	for _, address := range blocked {
		t.Run(address, func(t *testing.T) {
			var dialed bool
			d := pushDialer{
				lookup: func(context.Context, string, string) ([]netip.Addr, error) {
					return []netip.Addr{netip.MustParseAddr(address)}, nil
				},
				dial: func(context.Context, string, string) (net.Conn, error) {
					dialed = true
					return nil, errors.New("unexpected dial")
				},
			}
			_, err := d.dialContext(context.Background(), "tcp", "web.push.apple.com:443")
			require.ErrorIs(t, err, errPushAddress)
			require.False(t, dialed)
		})
	}
	for _, address := range []string{"17.57.144.1", "142.250.1.1", "44.237.65.1", "2607:f8b0:4007:80b::200a", "::ffff:17.57.144.1"} {
		require.True(t, publicPushIP(netip.MustParseAddr(address)), address)
	}
	require.False(t, publicPushIP(netip.Addr{}))
}

func TestPushMixedDNSAnswersFailClosed(t *testing.T) {
	for _, answers := range [][]netip.Addr{
		{netip.MustParseAddr("17.57.144.1"), netip.MustParseAddr("127.0.0.1")},
		{netip.MustParseAddr("fd00::1"), netip.MustParseAddr("2607:f8b0:4007:80b::200a")},
		{netip.MustParseAddr("17.57.144.1"), netip.MustParseAddr("::ffff:10.0.0.1")},
		nil,
	} {
		var dials int
		d := pushDialer{
			lookup: func(context.Context, string, string) ([]netip.Addr, error) { return answers, nil },
			dial: func(context.Context, string, string) (net.Conn, error) {
				dials++
				return nil, errors.New("unexpected dial")
			},
		}
		_, err := d.dialContext(context.Background(), "tcp", "web.push.apple.com:443")
		require.ErrorIs(t, err, errPushAddress)
		require.Zero(t, dials)
	}
}

func TestPushDNSRebindingCannotChangeDialedAddress(t *testing.T) {
	lookups := 0
	var dialed []string
	d := pushDialer{
		lookup: func(context.Context, string, string) ([]netip.Addr, error) {
			lookups++
			if lookups > 1 {
				return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
			}
			return []netip.Addr{netip.MustParseAddr("::ffff:17.57.144.1")}, nil
		},
		dial: func(_ context.Context, _, address string) (net.Conn, error) {
			dialed = append(dialed, address)
			conn, other := net.Pipe()
			_ = other.Close()
			return conn, nil
		},
	}
	conn, err := d.dialContext(context.Background(), "tcp", "web.push.apple.com:443")
	require.NoError(t, err)
	require.NoError(t, conn.Close())
	require.Equal(t, []string{"17.57.144.1:443"}, dialed, "dial the checked literal, never resolve the name twice")
	_, err = d.dialContext(context.Background(), "tcp", "web.push.apple.com:443")
	require.ErrorIs(t, err, errPushAddress, "a later connection must revalidate a changed answer")
	require.Len(t, dialed, 1)
}

func TestPushDialChecksProviderBeforeDNS(t *testing.T) {
	var lookups int
	d := pushDialer{lookup: func(context.Context, string, string) ([]netip.Addr, error) {
		lookups++
		return nil, errors.New("unexpected lookup")
	}}
	for _, address := range []string{"127.0.0.1:443", "evil.example:443", "web.push.apple.com:80", "web.push.apple.com:8443", "malformed"} {
		_, err := d.dialContext(context.Background(), "tcp", address)
		require.ErrorIs(t, err, errPushEndpoint)
	}
	_, err := d.dialContext(context.Background(), "udp", "web.push.apple.com:443")
	require.ErrorIs(t, err, errPushEndpoint)
	require.Zero(t, lookups)
}

func TestPushLookupFailureAndCancellationDoNotDial(t *testing.T) {
	d := pushDialer{lookup: func(ctx context.Context, _, _ string) ([]netip.Addr, error) {
		return nil, errors.New("resolver failure with sensitive metadata")
	}}
	_, err := d.dialContext(context.Background(), "tcp", "web.push.apple.com:443")
	require.ErrorIs(t, err, errPushAddress)
	require.NotContains(t, err.Error(), "sensitive metadata")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = d.dialContext(ctx, "tcp", "web.push.apple.com:443")
	require.ErrorIs(t, err, context.Canceled)
}

// pushTLSFixture uses the real restricted HTTP transport, real TLS hostname
// verification, and a private test CA. Only DNS and the final TCP socket dial are
// injected: production sees a provider hostname/public IP; tests connect to the
// isolated TLS listener. No public push provider receives test notifications.
func pushTLSFixture(t *testing.T, certificateHost string, handler http.Handler) (*restrictedPushClient, *atomic.Int32) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), DNSNames: []string{certificateHost},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IsCA: true, BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	require.NoError(t, err)
	cert, err := x509.ParseCertificate(der)
	require.NoError(t, err)
	srv := httptest.NewUnstartedServer(handler)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS12}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	dials := &atomic.Int32{}
	c := newPushHTTPClient(pushDialer{
		lookup: func(context.Context, string, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("17.57.144.1")}, nil
		},
		dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			dials.Add(1)
			if address != "17.57.144.1:443" {
				return nil, errors.New("test transport received an unchecked address")
			}
			return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
		},
	})
	tr := c.client.Transport.(*http.Transport)
	tr.TLSClientConfig.RootCAs = x509.NewCertPool()
	tr.TLSClientConfig.RootCAs.AddCert(cert)
	t.Cleanup(tr.CloseIdleConnections)
	return c, dials
}

func pushAgentWithClient(t *testing.T, endpoint string, client webpush.HTTPClient) *Agent {
	t.Helper()
	priv, pub, err := webpush.GenerateVAPIDKeys()
	require.NoError(t, err)
	return &Agent{
		vapidPriv: priv, vapidPub: pub, vapidSub: defaultVAPIDSubject, pushHTTP: client,
		sub: &webpush.Subscription{Endpoint: endpoint, Keys: webpush.Keys{P256dh: testP256dh, Auth: testAuth}},
	}
}

func TestPushHTTPSProvidersUseVerifiedTLSAndIgnoreProxyEnvironment(t *testing.T) {
	var proxyHits atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		proxyHits.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer proxy.Close()
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"} {
		t.Setenv(name, proxy.URL)
	}
	t.Setenv("NO_PROXY", "")
	t.Setenv("no_proxy", "")
	for _, host := range []string{"web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com", "wns2-am3p.notify.windows.com"} {
		t.Run(host, func(t *testing.T) {
			var requests atomic.Int32
			client, dials := pushTLSFixture(t, host, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				assert.Equal(t, http.MethodPost, r.Method)
				assert.Equal(t, host, r.Host)
				assert.Equal(t, host, r.TLS.ServerName, "SNI stays on the hostname despite dialing a checked IP")
				assert.NotEmpty(t, r.Header.Get("Authorization"), "real Web Push signature must be generated")
				w.WriteHeader(http.StatusCreated)
			}))
			a := pushAgentWithClient(t, "https://"+host+"/opaque?token=synthetic", client)
			require.NoError(t, a.Notify(context.Background()))
			require.Equal(t, int32(1), requests.Load())
			require.Equal(t, int32(1), dials.Load())
		})
	}
	require.Zero(t, proxyHits.Load(), "environment proxies must never receive a push request or CONNECT")
}

func TestPushTLSRejectsWrongProviderCertificate(t *testing.T) {
	var requests atomic.Int32
	client, _ := pushTLSFixture(t, "unrelated.example", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	a := pushAgentWithClient(t, "https://web.push.apple.com/capability-must-not-log", client)
	err := a.Notify(context.Background())
	require.ErrorIs(t, err, errPushHTTP)
	require.NotContains(t, err.Error(), "capability-must-not-log")
	require.NotContains(t, err.Error(), "https://")
	require.Zero(t, requests.Load())
}

func TestPushRedirectsAreNeverFollowed(t *testing.T) {
	var targetHits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		targetHits.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer target.Close()
	locations := []string{
		target.URL + "/internal-admin", "https://127.0.0.1/private",
		"https://fcm.googleapis.com/other-provider", "https://web.push.apple.com/same-provider",
		"https://evil.example/collect", "//evil.example/collect",
	}
	for _, status := range []int{301, 302, 303, 307, 308} {
		for i, location := range locations {
			t.Run(fmt.Sprintf("%d/%d", status, i), func(t *testing.T) {
				var requests atomic.Int32
				client, dials := pushTLSFixture(t, "web.push.apple.com", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					requests.Add(1)
					w.Header().Set("Location", location)
					w.WriteHeader(status)
				}))
				a := pushAgentWithClient(t, "https://web.push.apple.com/synthetic-capability", client)
				err := a.Notify(context.Background())
				require.ErrorContains(t, err, fmt.Sprintf("status %d", status))
				require.Equal(t, int32(1), requests.Load())
				require.Equal(t, int32(1), dials.Load())
			})
		}
	}
	require.Zero(t, targetHits.Load())
}

func TestPushMalformedRedirectDoesNotLeakCapability(t *testing.T) {
	client, _ := pushTLSFixture(t, "web.push.apple.com", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", ":bad/capability-must-not-log")
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	a := pushAgentWithClient(t, "https://web.push.apple.com/capability-must-not-log", client)
	err := a.Notify(context.Background())
	require.ErrorIs(t, err, errPushHTTP)
	require.NotContains(t, err.Error(), "capability-must-not-log")
	require.NotContains(t, err.Error(), "https://")
}
