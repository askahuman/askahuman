# Tiltfile — local dev loop. See architecture/0003.
# Bring the cluster up first:  ctlptl apply -f infra/local/cluster.yaml   (or: make up)
# Then:                        tilt up   (or headless: tilt ci  /  make ci-up)
#
# Builds: relay via ko (distroless static nonroot, no Dockerfile), web via Docker
# (Astro static bundle served by nginx-unprivileged). The MCP agent is a plain
# binary — NOT built or deployed here.

# Only ever talk to the local kind cluster — never the prod GKE context. Hard guard.
allow_k8s_contexts('kind-ask-a-human')

# Push built images to the ctlptl local registry (infra/local/cluster.yaml, host port 5005).
# default_registry rewrites the bare image names from infra/local into <registry>/<name>.
default_registry('localhost:5005')

# (a) Relay (Go) — ko builds ./backend/cmd/relay onto a distroless static nonroot base.
# custom_build invokes ko directly (no ext:// fetch needed). ko needs KO_DOCKER_REPO to be a
# REPOSITORY (no tag); --bare keeps the path bare and -t pins Tilt's tag, so ko pushes to exactly
# $EXPECTED_REGISTRY/$EXPECTED_IMAGE:$EXPECTED_TAG == $EXPECTED_REF. deps drives rebuilds.
custom_build(
    'ask-a-human-relay',
    # linux/arm64: local kind node runs the host arch (Apple Silicon). Prod (GKE/amd64) is
    # built separately by ko/Cloud Build, not here.
    'cd backend && KO_DOCKER_REPO=$EXPECTED_REGISTRY/$EXPECTED_IMAGE ko build --bare -t $EXPECTED_TAG --platform=linux/arm64 ./cmd/relay',
    deps=['./backend'],
    # A new image digest per build; Tilt reads the pushed ref from ko's stdout tag.
    skips_local_docker=True,
    disable_push=False,
)

# (b) Web (Astro static PWA) — Docker multi-stage build of ./frontend.
# live_update syncs source into the build context; the static bundle is rebuilt by the
# image build on change (no in-place server reload — minimum that works for static assets).
docker_build(
    'ask-a-human-web',
    './frontend',
    live_update=[
        sync('./frontend/src', '/app/src'),
        sync('./frontend/public', '/app/public'),
    ],
)

# (c) Apply the kind overlay (base Deployments/Services + local image refs + NodePort patches).
k8s_yaml(kustomize('infra/local'))

# (d) Access is via NodePort + kind extraPortMappings (infra/local/cluster.yaml), which already
# bind host 8080 -> relay (nodePort 30080) and host 8081 -> web (nodePort 30081). We deliberately
# do NOT add Tilt port_forwards on the same host ports — they would collide with the kind host
# bindings. NodePort also survives the Tilt UI not running, which the headless E2E relies on.
#   relay : http://localhost:8080  (/healthz, /ws)
#   web   : http://localhost:8081  (PWA)   container listens on 8080 (nginx-unprivileged)
k8s_resource('ask-a-human-relay')
k8s_resource('ask-a-human-web')
