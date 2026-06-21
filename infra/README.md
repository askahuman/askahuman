# infra

Kustomize manifests + local dev orchestration for **ask-a-human** (relay + web PWA).
No database, single replica each, two container images. The MCP agent is a separately
distributed binary — it is **not** an image and is not deployed here.

## Layout

```
infra/
├── base/     shared Deployments + Services (image refs are bare, rewritten per overlay)
├── local/    kind overlay: NodePort + ctlptl cluster/registry  (kubectl kustomize infra/local)
└── prod/     GKE scaffold: ingress + managed cert + frontend/backend config (scaffold ONLY)
```

The two images:
- `ask-a-human-relay` — Go WebSocket rendezvous, built by **ko** (distroless static nonroot). Listens `:8080`, serves `/healthz` + `/ws`.
- `ask-a-human-web` — static Astro PWA served by **nginx-unprivileged**. Listens `:8080` (non-root).

## Hardening (base)

Both Deployments run locked down (`base/{relay,web}-deployment.yaml`):
- `runAsNonRoot`, non-zero `runAsUser` (relay `65532` distroless, web `101` nginx-unprivileged), `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, all capabilities dropped, `seccompProfile: RuntimeDefault`.
- web mounts `emptyDir`s for nginx scratch (`/var/cache/nginx`, `/var/run`, `/tmp`) since root is read-only.
- CPU+memory requests and limits on both.
- `base/network-policy.yaml`: least-privilege — ingress pinned to port `8080`, egress restricted to DNS (no DB/upstream calls). Ingress *source* stays open per-port because GKE LB/health-check traffic arrives from non-selectable IP ranges; tighten at the edge with Cloud Armor (below).

## Local dev

Requires `ctlptl`, `kind`, `ko`, `tilt`, `kubectl`, Docker. On Apple Silicon these live in `/opt/homebrew/bin` (the Makefile prepends it to `PATH`).

```sh
make up      # ctlptl apply (kind cluster + local registry :5005) ; tilt up (interactive UI)
make down    # tilt down ; ctlptl delete (tears down cluster + registry)
make ci-up   # headless: ctlptl apply ; tilt ci (build + apply + wait for healthy, no UI) — for E2E
```

- **Cluster:** kind `kind-ask-a-human` (k8s context `kind-ask-a-human`). Tilt is pinned to this context via `allow_k8s_contexts` so it can never target prod.
- **Registry:** ctlptl `ctlptl-registry` on host port `5005`; Tilt's `default_registry('localhost:5005')` pushes the built images there.
- **Port-forwards** (set by the Tiltfile):
  - relay → `http://localhost:8080` (`/healthz`, `/ws`)
  - web   → `http://localhost:8081`
- kind also maps NodePorts to the host as a fallback (`30080→8080` relay, `30081→8081` web), so standalone `kubectl apply -k infra/local` is reachable without Tilt (push images as `localhost:5005/ask-a-human-{relay,web}:local` first).
- **Cluster config** lives only in `local/cluster.yaml` (ctlptl inline kind config). The old standalone `local/kind-config.yaml` was a byte-duplicate with no caller and was removed.

## Prod (GKE) — scaffold only, NOT auto-deployed

`infra/prod` is a **scaffold**: it is intentionally **not** applied by `make up`/`make ci-up`, and this build does **not** push to the real Artifact Registry or `<gke-cluster>` cluster (plan §15). Deploy + E2E happen only on local kind.

It targets GKE with:
- L7 `Ingress` (gce) sharing one host: `/ws` + `/healthz` → relay, everything else → web.
- `ManagedCertificate` for TLS (WSS is mandatory for PWA / service workers / Web Push).
- `FrontendConfig` (HTTP → HTTPS redirect).
- `BackendConfig` for the relay: `timeoutSec: 3600` so the GLB does not cut long-lived WebSockets; health check `/healthz` on port 8080.
- Image refs: `<artifact-registry>/ask-a-human/{relay,web}:VERSION` (CI sets `VERSION`).

### Privacy: relay request logging MUST stay off (HARD INVARIANT)

The room id rides on the relay URL (`/ws?room=...`). GKE HTTP(S) LB **access logging would
persist that room id to Cloud Logging**, defeating the RAM-only metadata guarantee. The relay
`BackendConfig` (`prod/frontend-config.yaml`) therefore sets `logging.enable: false`. **Never
flip it to `true`** and never enable LB access/request logging for the relay backend by any
other means. (The web backend serves no per-room URLs, but keep its logging minimal too.)

### Rate limiting (Cloud Armor) — manual cloud step, not in these manifests

Per-IP rate limiting for `/ws` (connection-flood protection) is a project-level Cloud Armor
security policy — a Cloud resource, not a k8s object. It is intentionally **not** encoded here
(no inventable CRD). To enable: create the policy out-of-band, then reference it from a relay
`BackendConfig` via `spec.securityPolicy.name`. See the TODO annotation in `prod/ingress.yaml`.

### TODO before any prod use

Domain is set to **`ask-a-human.ai`** (`prod/ingress.yaml` host + `prod/managed-certificate.yaml` domains).
Before deploying:
- Reserve the global static IP: `gcloud compute addresses create ask-a-human-global-ip --global`.
- Point `ask-a-human.ai`'s A record at that IP (the managed cert won't provision until DNS resolves to it).
- Set `VERSION` (the `{relay,web}` image tag) in `prod/kustomization.yaml`.

## Verify the manifests render

```sh
kubectl kustomize infra/local >/dev/null   # local overlay
kubectl kustomize infra/prod  >/dev/null   # prod scaffold
```
