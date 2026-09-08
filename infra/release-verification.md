# Release verification

`production-preflight` is a manually dispatched, read-only workflow using the
existing production environment, WIF identity and Connect Gateway access. It
serializes with tag deployments and creates a temporary runner kubeconfig. It
never uses a developer's current kube context, reads Secrets, changes a cloud or
Kubernetes resource, or enables request logging. Run the reviewed workflow on
`main` before publishing a release:

```sh
gh workflow run production-preflight.yml --ref main
```

The job reads only the two application Deployments and their selected pods, the
relay Service and EndpointSlices, the application Ingress, and the relay
BackendConfig in namespace `ask-a-human`. An additional exact-name read of the
relay's core Endpoints object checks which endpoint API the existing identity
can access. A strict single-pod alternative below applies only to an explicitly
forbidden or absent EndpointSlice API. Ready endpoint membership remains required. Raw API
responses and CLI errors remain in memory. Logs contain fixed check/diagnostic
names, booleans, and allowlisted failure classes. Missing permission, unavailable
APIs, timeout, unknown readiness formats and malformed data fail the named check;
they do not cause a raw diagnostic dump. No additional roles, secrets or global
resources are requested.

Failed operations include a `failure` category such as `forbidden`, `not_found`,
`unauthenticated`, `timeout`, `unavailable`, `rate_limited`, `invalid_request`,
`api_error`, `network_error`, `tls_error`, `tool_unavailable`, `tool_error`,
`invalid_json`, `invalid_data`, or `unknown_error`. The category comes from a
closed mapping of known API/CLI errors, never from an exception's raw message,
resource name, URI, command arguments or headers. An unknown error stays unknown.
`diagnostic` records are additional evidence and cannot turn a required failure
into a pass. A false reason-category diagnostic is normal when that reason is
absent; the required `check` results control workflow success.

The topology checks require a ready single replica for each Deployment, the
configured images actually running, a `gce` Ingress routing the public relay
paths, the relay's ingress NEG, matching complete ready endpoint membership,
and positive health evidence for that NEG and its global backend. Pod
`cloud.google.com/load-balancer-neg-ready=True` alone is insufficient: GKE can
set it when a health check times out or is absent. The checker recognizes the
controller's positive healthy message, including the current NEG name/zone and
global backend, and cross-checks the Ingress `HEALTHY` annotation. Unexpected
controller message changes fail closed and require review. See the
[GKE Ingress health annotation](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/ingress-configuration#validating_backend_service_properties),
[readiness controller](https://github.com/kubernetes/ingress-gce/blob/master/pkg/neg/readiness/reflector.go),
and [resource-key format](https://github.com/GoogleCloudPlatform/k8s-cloud-provider/blob/master/pkg/cloud/meta/key.go).

NEG diagnostics separately report backend registration/health, pod readiness-gate
and condition presence, true condition, positive reason, recognized positive
message format, and an exact current NEG/zone/global-backend identity match.
Additional booleans identify the controller's timeout, no-health-check, not-ready,
no-NEG, non-default-subnet, or unrecognized condition branches. This distinguishes
an unhealthy backend from a controller-format/identity mismatch while retaining
the same exact positive-health gate.

If `relay_endpoints_read` reports `forbidden` or `not_found`, the required
`relay_ready_endpoints_match_pods` check can use the exact named core Endpoints
object. `relay_membership_uses_core_api` makes that choice explicit. The core
object must contain exactly one subset, one ready address and TCP port 8080;
its Pod name, UID, namespace and IP must match the one running, ready relay Pod.
The Pod must have exactly one address. Any extra/duplicate endpoint, subset or
port, unready address, truncation annotation, different identity, dual-stack Pod,
multiple active Pods or `publishNotReadyAddresses` setting rejects this path.
The Service's selector and sole TCP port/target port must also match the relay.
Within this narrow topology, the same complete IP/UID/port membership evidence
is available through either API. The core API is deprecated and cannot provide
general dual-stack or large-service equivalence; use EndpointSlices before
expanding that topology. See [Kubernetes Endpoints limitations](https://kubernetes.io/docs/concepts/services-networking/service/#endpoints-deprecated).

A readable but empty, malformed, unready or mismatched EndpointSlice result
still fails, even when core Endpoints look healthy. Authentication, timeout,
network/TLS and other API errors also fail without substitution. Both reads
remain redacted diagnostic records; an actual matching endpoint source is always
required. No permission check creates a SubjectAccessReview, and neither API
read changes RBAC. Upstream Kubernetes includes EndpointSlice and Endpoints read
permissions in aggregated view/edit roles, but an installed role or gateway can
differ. See the
[Kubernetes 1.33 default read rules](https://github.com/kubernetes/kubernetes/blob/v1.33.0/plugin/pkg/auth/authorizer/rbac/bootstrappolicy/policy.go).

## Historical NEG conditions and a new rollout

The upstream readiness controller stops processing a Pod once its NEG condition
is true, regardless of the reason. A `LoadBalancerNegWithoutHealthCheck` condition
can therefore persist after a backend is later attached and becomes healthy.
This explains a possible historical state; a healthy backend annotation alone
does not prove that this is the cause or establish current per-Pod health. See
[`needToProcess` / `evalNegReadinessGate`](https://github.com/kubernetes/ingress-gce/blob/master/pkg/neg/readiness/utils.go)
and the [controller's early return and condition assignment](https://github.com/kubernetes/ingress-gce/blob/master/pkg/neg/readiness/reflector.go).

The preflight continues to reject a no-health-check condition, including when
core endpoint membership and the backend annotation pass. Read-only checks
cannot refresh that historical Pod condition. A planned new release Pod must
obtain fresh positive readiness evidence through the existing postrollout gate;
neither a historical condition nor an automatic restart/exception is used to
turn the current deployment's check green. The public version/proxy checks after
rollout remain required as well.

The logging check confirms `BackendConfig.spec.logging.enable=false` and the
Service's reference to that configuration. It does **not** query the Compute API
or independently certify the live Cloud Logging setting. Likewise, Kubernetes
controller status is evidence of the configured/observed path; the public probe
below verifies the actual request path after rollout.

## Tag deployment and public checks

The existing `deploy` workflow builds the relay and web with the tag's version
and full commit, waits for both rollouts, reruns the topology checks with exact
expected image tags and production proxy configuration, and then probes the
fixed public HTTPS origin. A failed check fails the workflow; it does not roll
back or mutate the deployment again. Allow the GKE controller to settle, inspect
the fixed failure name, and rerun verification before declaring the release
ready. To repeat the checks independently, supply a version without `v` and its
full public commit:

```sh
gh workflow run production-preflight.yml --ref main \
  -f expected_version=1.2.3 \
  -f expected_commit=0123456789012345678901234567890123456789
```

The public probe verifies all of the following without following redirects or
using proxy environment variables:

- `/version.json` returns exactly the web version and full commit, with
  `Cache-Control: no-store`. It is excluded from the service-worker precache.
- `/healthz` retains the body `ok`, adds no-store and public `X-AAH-Version` /
  `X-AAH-Commit` headers, and matches the released relay build.
- `/healthz/proxy` returns exactly `trusted_proxy` and `valid_suffix` booleans,
  with no-store and no IP, header, room, key or connection count. It uses the
  **same canonical trust and suffix parser as connection accounting**. Both
  booleans must be true on ordinary requests and when a forged XFF prefix is
  prepended. Direct exposure still ignores XFF by default.

These are small unauthenticated GET requests. They do not create rooms or
exercise WebSocket capacity. Separate bounded live tests must verify independent
client budgets and the 100-room workload. Local fixtures and a positive probe
cannot establish physical iPhone notification delivery.

## Identify the version on a phone and local agent

The pairing screen footer displays the version and short commit baked into the
running app bundle. Its **deployment details** link opens the uncached public
JSON separately, so an old cached app can be distinguished from the latest web
deployment. Open **Add agent** from an existing installation to reach this
footer. If its build differs from the announced release, close and reopen the
installed app with a network connection and check it again before testing.

Run `ask-a-human version` or `npx -y @askahuman/mcp@VERSION version --json` to
identify the local agent without starting pairing or reading persistent agent
configuration. The GitHub release embeds GoReleaser's version and full commit;
plain development builds report `dev` / `unknown`. Web Docker builds accept
`PUBLIC_BUILD_VERSION` and `PUBLIC_BUILD_COMMIT`; relay `ko` builds accept
`AAH_BUILD_VERSION` and `AAH_BUILD_COMMIT`. These are public build metadata, not
runtime configuration or secrets.

Before asking for iPhone acceptance, confirm the release workflows and public
checks succeeded, give the user the exact expected version/short commit, and use
a synthetic approval. Have the user confirm the visible version, pair or restore
the agent, approve/decline a foreground request, then lock/background the phone
and test a fresh notification and its tap-through. Record which steps were
actually completed on the physical device; desktop emulation is separate evidence.

## Maintained local and CI checks

`python3 -m unittest discover -s scripts -p test_release_verification.py -v`
tests healthy/broken topology, unsupported NEG readiness, CLI/API failure
redaction, isolated kubeconfig use, stale/cacheable public versions, exact
boolean-only responses, redirects and proxy environment handling without live
services. The Go suite verifies the proxy endpoint against the accounting
classifier. `python3 scripts/check_agent_version.py` builds and runs development
and versioned CLI artifacts. The Linux web-container job builds with explicit
metadata and checks the actual nginx `/version.json` body, cache/security headers
and service-worker exclusion under the production runtime restrictions.
