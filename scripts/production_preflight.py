#!/usr/bin/env python3
"""Read-only GKE release checks. Never print command output or runtime identity.

The CLI requires an Actions runner and uses an isolated Connect Gateway config.
The existing deployer permissions suffice: no Compute API or cluster-wide read.
"""
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

NAMESPACE = "ask-a-human"
RELAY = "ask-a-human-relay"
WEB = "ask-a-human-web"
INGRESS = "ask-a-human-ingress"
BACKEND = "ask-a-human-relay-backend-config"
NEG_READY = "cloud.google.com/load-balancer-neg-ready"
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:alpha|beta|rc)\.[0-9]+)?\Z")
COMMIT = re.compile(r"[0-9a-f]{40}\Z")


class Report:
    def __init__(self):
        self.ok = True

    def check(self, name, predicate):
        # Names are constants at call sites. Untrusted API/CLI exception messages
        # may contain credentials, headers or private resource paths: discard.
        try:
            ok = bool(predicate())
        except Exception:
            ok = False
        self.ok = self.ok and ok
        print(json.dumps({"check": name, "ok": ok}), flush=True)
        return ok


def command(args, env):
    result = subprocess.run(args, env=env, capture_output=True, text=True,
                            timeout=45, check=False)
    if result.returncode != 0:
        raise RuntimeError("command failed")
    return result.stdout


def read_object(report, key, args, env):
    obj = {}

    def read():
        nonlocal obj
        value = json.loads(command(["kubectl", "--namespace", NAMESPACE,
                                    "--request-timeout=30s", "get", *args, "-o", "json"], env))
        if not isinstance(value, dict):
            return False
        obj = value
        return True

    report.check(key + "_read", read)
    return obj


def annotation(obj, name):
    value = json.loads(obj["metadata"]["annotations"][name])
    if not isinstance(value, dict):
        raise ValueError("annotation must be an object")
    return value


def active_pods(pods):
    return [p for p in pods["items"] if not p["metadata"].get("deletionTimestamp")]


def rollout_ready(deployment, pods, container_name, expected_version, registry):
    spec, status = deployment["spec"], deployment["status"]
    desired = spec["replicas"]
    # Room affinity relies on the single relay replica; both manifests use one.
    if desired != 1 or status["observedGeneration"] < deployment["metadata"]["generation"]:
        return False
    if any(status.get(k, 0) != desired for k in
           ("replicas", "updatedReplicas", "readyReplicas", "availableReplicas")):
        return False
    if status.get("unavailableReplicas", 0):
        return False
    containers = spec["template"]["spec"]["containers"]
    if len(containers) != 1 or containers[0]["name"] != container_name:
        return False
    image = containers[0]["image"]
    if expected_version and image != f"{registry}/{container_name}:{expected_version}":
        return False
    selected = active_pods(pods)
    if len(selected) != desired:
        return False
    for pod in selected:
        ps = pod["spec"]
        if ps.get("hostNetwork") or ps.get("initContainers") or len(ps["containers"]) != 1:
            return False  # No node/sidecar proxy in the tested GFE -> pod path.
        if ps["containers"][0]["image"] != image:
            return False
        if pod["status"]["phase"] != "Running":
            return False
        if not any(c["type"] == "Ready" and c["status"] == "True" for c in pod["status"]["conditions"]):
            return False
        statuses = pod["status"]["containerStatuses"]
        if len(statuses) != 1 or statuses[0]["name"] != container_name:
            return False
        if not statuses[0]["ready"] or not statuses[0]["imageID"]:
            return False
    return True


def ingress_routes(ingress):
    if ingress["metadata"]["annotations"]["kubernetes.io/ingress.class"] != "gce":
        return False
    if not ingress["status"]["loadBalancer"]["ingress"]:
        return False
    rules = [r for r in ingress["spec"]["rules"] if r.get("host") == "ask-a-human.ai"]
    if len(rules) != 1:
        return False
    paths = rules[0]["http"]["paths"]
    for path in ("/ws", "/healthz"):
        matches = [p for p in paths if p["path"] == path]
        if len(matches) != 1 or matches[0]["pathType"] != "Prefix":
            return False
        if matches[0]["backend"]["service"] != {"name": RELAY, "port": {"number": 8080}}:
            return False
    return True


def service_neg(service):
    spec = service["spec"]
    if spec["type"] != "ClusterIP" or spec["selector"] != {"app": RELAY}:
        return False
    if not any(p["port"] == 8080 and p["targetPort"] == 8080 for p in spec["ports"]):
        return False
    if annotation(service, "cloud.google.com/neg").get("ingress") is not True:
        return False
    status = annotation(service, "cloud.google.com/neg-status")
    return (isinstance(status["network_endpoint_groups"]["8080"], str)
            and bool(status["network_endpoint_groups"]["8080"])
            and isinstance(status["zones"], list) and bool(status["zones"])
            and all(isinstance(z, str) and z for z in status["zones"]))


def healthy_neg(service, ingress, pods):
    neg_status = annotation(service, "cloud.google.com/neg-status")
    neg = neg_status["network_endpoint_groups"]["8080"]
    if not isinstance(neg, str) or not neg:
        return False
    if annotation(ingress, "ingress.kubernetes.io/backends").get(neg) != "HEALTHY":
        return False
    selected = active_pods(pods)
    if not selected:
        return False
    for pod in selected:
        if {"conditionType": NEG_READY} not in pod["spec"]["readinessGates"]:
            return False
        conditions = [c for c in pod["status"]["conditions"] if c["type"] == NEG_READY]
        # GKE also sets NEG-ready=True when health checks are absent or time out.
        # Accept only a positive healthy-in-this-NEG observation with a backend.
        if len(conditions) != 1:
            return False
        c = conditions[0]
        if c["status"] != "True" or c["reason"] != "LoadBalancerNegReady":
            return False
        message = c.get("message", "")
        healthy_messages = set()
        for zone in neg_status["zones"]:
            # Controller uses Go %q around meta.Key.String(); the resources are
            # GCE names (ASCII). Require the current NEG, zone and global backend.
            neg_key = json.dumps(f'Key{{"{neg}", zone: "{zone}"}}')
            backend_key = json.dumps(f'Key{{"{neg}"}}')
            for spacing in ("", " "):
                healthy_messages.add(f'Pod has become Healthy in NEG {neg_key} attached to BackendService '
                                     f'{backend_key}.{spacing}Marking condition "{NEG_READY}" to True.')
        if message not in healthy_messages:
            return False
    return True


def endpoints_match(pods, slices):
    expected = set()
    for pod in active_pods(pods):
        for address in pod["status"]["podIPs"]:
            expected.add((pod["metadata"]["uid"], address["ip"]))
    observed = set()
    for slice_ in slices["items"]:
        if not any(p.get("port") == 8080 and p.get("protocol", "TCP") == "TCP" for p in slice_["ports"]):
            return False
        for endpoint in slice_["endpoints"]:
            if endpoint["conditions"].get("terminating"):
                continue
            if endpoint["conditions"].get("ready") is not True:
                return False
            ref = endpoint["targetRef"]
            if ref["kind"] != "Pod" or ref.get("namespace") != NAMESPACE:
                return False
            observed.update((ref["uid"], ip) for ip in endpoint["addresses"])
    return bool(expected) and expected == observed


def proxy_settings(deployment):
    container = deployment["spec"]["template"]["spec"]["containers"][0]
    if container.get("envFrom"):
        return False
    entries = container.get("env", [])
    env = {e["name"]: e.get("value") for e in entries}
    if len(env) != len(entries):
        return False
    return (env.get("AAH_RELAY_TRUST_PROXY") == "1"
            and env.get("AAH_RELAY_XFF_CLIENT_FROM_RIGHT") == "2"
            and env.get("AAH_RELAY_TRUSTED_PROXY_CIDRS") == "35.191.0.0/16,130.211.0.0/22,2600:2d00:1:1::/64"
            and env.get("AAH_RELAY_MAX_CONNS_PER_IP") == "256"
            and env.get("AAH_RELAY_VERBOSE", "0") == "0")


def check_cluster(report, env, expected_version=""):
    objects = {}
    reads = {
        "relay_deployment": ["deployment", RELAY],
        "web_deployment": ["deployment", WEB],
        "relay_service": ["service", RELAY],
        "ingress": ["ingress", INGRESS],
        "relay_backendconfig": ["backendconfig.cloud.google.com", BACKEND],
        "relay_pods": ["pods", "--selector=app=" + RELAY],
        "web_pods": ["pods", "--selector=app=" + WEB],
        "relay_endpoints": ["endpointslices.discovery.k8s.io", "--selector=kubernetes.io/service-name=" + RELAY],
    }
    for key, args in reads.items():
        objects[key] = read_object(report, key, args, env)
    relay, web = objects["relay_deployment"], objects["web_deployment"]
    service, ingress, pods = objects["relay_service"], objects["ingress"], objects["relay_pods"]
    report.check("relay_rollout_and_image", lambda: rollout_ready(relay, pods, "relay", expected_version, env.get("GAR_REGISTRY")))
    report.check("web_rollout_and_image", lambda: rollout_ready(web, objects["web_pods"], "web", expected_version, env.get("GAR_REGISTRY")))
    report.check("ingress_gce_relay_routes", lambda: ingress_routes(ingress))
    report.check("relay_service_ingress_neg", lambda: service_neg(service))
    report.check("relay_neg_observed_healthy", lambda: healthy_neg(service, ingress, pods))
    report.check("relay_ready_endpoints_match_pods", lambda: endpoints_match(pods, objects["relay_endpoints"]))
    report.check("relay_logging_disabled_in_backendconfig", lambda:
                 annotation(service, "cloud.google.com/backend-config") == {"default": BACKEND}
                 and objects["relay_backendconfig"]["spec"]["logging"]["enable"] is False)
    if expected_version:
        report.check("relay_production_proxy_settings", lambda: proxy_settings(relay))


def main():
    report = Report()
    expected = os.environ.get("EXPECTED_VERSION", "")
    if not report.check("preflight_inputs", lambda:
                        os.environ.get("GITHUB_ACTIONS") == "true"
                        and bool(os.environ.get("GCP_PROJECT"))
                        and bool(os.environ.get("GKE_CLUSTER"))
                        and (not expected or VERSION.fullmatch(expected) and os.environ.get("GAR_REGISTRY"))
                        and Path(os.environ["RUNNER_TEMP"]).is_absolute()):
        return 1
    try:
        with tempfile.TemporaryDirectory(prefix="aah-preflight-", dir=os.environ["RUNNER_TEMP"]) as directory:
            env = dict(os.environ, KUBECONFIG=str(Path(directory) / "config"), CLOUDSDK_CORE_DISABLE_PROMPTS="1")
            if report.check("connect_gateway_credentials", lambda: command([
                    "gcloud", "container", "fleet", "memberships", "get-credentials", env["GKE_CLUSTER"],
                    "--project", env["GCP_PROJECT"], "--quiet"], env) is not None):
                check_cluster(report, env, expected)
    except Exception:
        report.check("preflight_execution", lambda: False)
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
