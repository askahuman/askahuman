# Security Policy

**ask-a-human** lets your AI agent ask a human — on your phone. End-to-end encrypted, no accounts, no database.

## Threat model

The architecture is deliberately split so no single piece holds everything:

- **The relay is content-blind.** It only ever sees `base64(nonce‖ciphertext)` and which room talks to which. No database, RAM-only — restart means re-pair. It cannot read messages, and it is open-source and self-hostable (override `--relay` / `--public-relay`).
- **The agent runs locally**, next to your editor (Cursor/Claude/Codex) via `npx @askahuman/mcp serve`. It holds the SPAKE2-derived key and the plaintext. It exposes `request_approval` (the only decision-bearing tool), plus two read-only helpers, `pair_status` and `start_pairing`, that report non-secret status and never return the code. `request_approval` blocks until a human answers (approve / decline / choose / reply). It never auto-approves.
- **The phone PWA** (https://ask-a-human.ai/app) is the only other key-holder.

Pairing uses a Magic-Wormhole-style SPAKE2 handshake: a short code becomes a strong shared key, so the relay cannot MITM the exchange.

Because the relay can't read anything, the **highest-value targets are the PWA and the pairing channel**:

- **The PWA** — XSS or clickjacking against the PWA defeats end-to-end encryption by reaching plaintext or hijacking the human's decision.
- **The pairing channel** — an attacker who breaks the SPAKE2 handshake or tricks a user through a malicious code could insert themselves between agent and human.

Reports touching these areas are especially valuable.

## Web Push destination boundary

Push subscriptions are supplied by the phone. The agent treats their endpoints
as untrusted network destinations even when the subscription arrived in an
encrypted session. It accepts HTTPS on port 443 (implicit or explicit), without
credentials or fragments, for these provider-controlled DNS names only:

| Provider | Accepted host |
| --- | --- |
| Apple / iPhone Home Screen web apps | Subdomains of `push.apple.com`, including `web.push.apple.com` |
| Google FCM / Chrome | Exact `fcm.googleapis.com` |
| Mozilla / Firefox | Exact `updates.push.services.mozilla.com` |
| Microsoft WNS / Edge | Subdomains of `notify.windows.com` |

The Apple and Microsoft suffixes require a complete DNS-label boundary; similar
domains, literal IPs, trailing dots, Unicode hostnames, and nonstandard ports are
rejected. DNS names compare without case sensitivity. Paths and queries remain
opaque, unchanged capabilities. Provider policies are grounded in
[WebKit's iOS Web Push guidance](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/),
[Google's Web Push subscription examples](https://web.dev/articles/push-notifications-overview),
[Mozilla's production endpoint documentation](https://mozilla-services.github.io/autopush-rs/),
and [Microsoft's WNS domain validation guidance](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/wns-overview).

For every new connection, the agent resolves the provider hostname, rejects the
entire result if any address is private or special-purpose, and dials a validated
literal address. This prevents a second DNS lookup from changing the destination
after validation. IPv4-mapped IPv6 addresses are checked as IPv4. The conservative
exclusions cover the [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry)
and [IPv6 special-purpose registries](https://www.iana.org/assignments/iana-ipv6-special-registry),
including loopback, private/link-local, shared-address, documentation, benchmark,
translation, and transition ranges. IPv6 destinations must be ordinary global
unicast addresses. TLS still authenticates the provider hostname with the system
trust store; dialing an IP never disables certificate or hostname verification.

**Redirects are never followed**, including same-provider redirects. The push
client ignores HTTP(S)/ALL proxy environment settings and does not inherit the
global default HTTP transport. Requests have a 10-second overall timeout and
bounded connection, TLS, response-header and pool limits. Errors do not include
subscription URLs, tokens, redirect locations, or response bodies. Invalid
subscription updates do not replace a previously accepted subscription, and the
send path revalidates the endpoint before producing a network request.

This deliberately does **not** support arbitrary/self-hosted push providers,
proxy-only outbound networks, or private/NAT64-only provider routes. The agent
needs direct outbound HTTPS to a supported provider's public addresses. Hosting
your own relay/PWA remains separate from the browser vendor's push service; it
does not require adding your relay as a push destination. If a browser provider
changes domains, add its documented ownership/endpoint policy with regression
tests rather than disabling these checks. Foreground approvals continue to use
the relay when push is unavailable.

This boundary limits network access from a compromised phone/session key. It
does not authenticate subscription updates with the device signing key, prove
which person owns a permitted subscription, or solve multi-agent VAPID ownership.
Those are separate protocol concerns. Tests use local TLS fixtures for delivery;
physical iPhone wake-up and real provider delivery still require device testing.

## Supported versions

We support the latest published `@askahuman/mcp` (npm) and the latest release. Please reproduce on the latest version before reporting.

## Reporting a vulnerability

**Primary:** Use GitHub private vulnerability reporting — click **"Report a vulnerability"** under the repo **Security** tab (GitHub Security Advisories) at https://github.com/askahuman/askahuman.

**Secondary:** Email security@ask-a-human.ai.

Please include steps to reproduce, affected version, and impact. Do **not** open a public issue for security reports.

## Our commitment

- We acknowledge reports quickly.
- There is **no bug bounty** — we cannot offer monetary rewards.
- Once a report is confirmed, we aim to patch and cut a release promptly.
- We prefer **coordinated disclosure**: please give us a reasonable window before going public.

## Out of scope

- Misconfiguration of a self-hosted relay or web deployment.
- Social engineering of the human approver (e.g. tricking them into approving).
- Denial of service against your own local agent or self-hosted relay.
- Vulnerabilities in third-party dependencies without a demonstrated impact on ask-a-human.
- Issues requiring a compromised device, malicious browser extension, or physical access to an unlocked phone.
