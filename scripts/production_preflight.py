#!/usr/bin/env python3
"""Read-only GKE release checks. Never print command output or runtime identity.

The CLI requires an Actions runner and uses an isolated Connect Gateway config.
One named Compute backend health read can verify a historical no-health-check
condition. Missing existing permissions fail closed; no IAM or cluster mutation.
"""
import ipaddress
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
FAILURE_CLASSES = frozenset({"forbidden", "not_found", "unauthenticated", "timeout",
                             "unavailable", "rate_limited", "invalid_request", "api_error",
                             "network_error", "tls_error", "tool_unavailable", "tool_error",
                             "invalid_json", "invalid_data", "unknown_error"})


class CheckFailure(Exception):
    def __init__(self, category):
        self.category = category if category in FAILURE_CLASSES else "unknown_error"
        super().__init__(self.category)


def failure_class(error):
    if isinstance(error, CheckFailure):
        return error.category if error.category in FAILURE_CLASSES else "unknown_error"
    if isinstance(error, subprocess.TimeoutExpired):
        return "timeout"
    if isinstance(error, json.JSONDecodeError):
        return "invalid_json"
    if isinstance(error, (KeyError, TypeError, ValueError)):
        return "invalid_data"
    return "unknown_error"


class Report:
    def __init__(self):
        self.ok = True
        self.failures = {}

    def _result(self, field, name, predicate):
        # Names are constants at call sites. Untrusted API/CLI exception messages
        # may contain credentials, headers or private resource paths: discard.
        result = {field: name}
        self.failures.pop(name, None)
        try:
            ok = bool(predicate())
        except Exception as error:
            ok = False
            result["failure"] = failure_class(error)
            self.failures[name] = result["failure"]
        result["ok"] = ok
        print(json.dumps(result), flush=True)
        return ok

    def check(self, name, predicate):
        ok = self._result("check", name, predicate)
        self.ok = self.ok and ok
        return ok

    def diagnostic(self, name, predicate):
        # Additional evidence never satisfies or bypasses a required check.
        return self._result("diagnostic", name, predicate)


def command_failure(stdout, stderr):
    """Map known CLI/API errors to a closed vocabulary; never return raw text."""
    reasons = {"Forbidden": "forbidden", "NotFound": "not_found",
               "Unauthorized": "unauthenticated", "Timeout": "timeout",
               "ServerTimeout": "timeout", "ServiceUnavailable": "unavailable",
               "TooManyRequests": "rate_limited", "BadRequest": "invalid_request",
               "InternalError": "api_error"}
    for raw in (stdout, stderr):
        try:
            status = json.loads(raw)
            if isinstance(status, dict) and status.get("kind") == "Status":
                return reasons.get(status.get("reason"), "api_error")
        except (ValueError, TypeError):
            pass
    for reason, category in reasons.items():
        if re.search(r"^Error from server \(" + reason + r"\):", stderr, re.MULTILINE):
            return category
    text = stderr.lower()
    for fragments, category in [
        (("permission_denied",), "forbidden"),
        (("required 'compute.backendservices.get' permission",), "forbidden"),
        (("the server doesn't have a resource type", "the server could not find the requested resource"), "not_found"),
        (("you must be logged in to the server", "invalid_grant", "unauthenticated"), "unauthenticated"),
        (("i/o timeout", "context deadline exceeded", "timed out"), "timeout"),
        (("x509:", "tls handshake", "certificate verify failed"), "tls_error"),
        (("connection refused", "no such host", "network is unreachable", "connection reset"), "network_error"),
    ]:
        if any(fragment in text for fragment in fragments):
            return category
    return "tool_error"


def command(args, env):
    try:
        result = subprocess.run(args, env=env, capture_output=True, text=True,
                                timeout=45, check=False)
    except subprocess.TimeoutExpired:
        raise CheckFailure("timeout") from None
    except FileNotFoundError:
        raise CheckFailure("tool_unavailable") from None
    except OSError:
        raise CheckFailure("tool_error") from None
    if result.returncode != 0:
        raise CheckFailure(command_failure(result.stdout, result.stderr)) from None
    return result.stdout


def read_object(report, key, args, env, *, diagnostic=False):
    obj = {}

    def read():
        nonlocal obj
        value = json.loads(command(["kubectl", "--namespace", NAMESPACE,
                                    "--request-timeout=30s", "get", *args, "-o", "json"], env))
        if not isinstance(value, dict):
            raise CheckFailure("invalid_data")
        obj = value
        return True

    emit = report.diagnostic if diagnostic else report.check
    emit(key + "_read", read)
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
        if message not in healthy_neg_messages(neg_status):
            return False
    return True


def healthy_neg_messages(neg_status):
    # The existing positive health gate remains an exact match against current
    # NEG/zone/global-backend identity and the reviewed controller formats.
    neg = neg_status["network_endpoint_groups"]["8080"]
    messages = set()
    for zone in neg_status["zones"]:
        neg_key = json.dumps(f'Key{{"{neg}", zone: "{zone}"}}')
        backend_key = json.dumps(f'Key{{"{neg}"}}')
        for spacing in ("", " "):
            messages.add(f'Pod has become Healthy in NEG {neg_key} attached to BackendService '
                         f'{backend_key}.{spacing}Marking condition "{NEG_READY}" to True.')
    return messages


def direct_health_target(report, objects, core_endpoints, env, expected_version,
                         slice_read="relay_endpoints_read"):
    """Qualify only the known historical branch and bind a complete snapshot."""
    service, ingress, pods = (objects[k] for k in ("relay_service", "ingress", "relay_pods"))
    deployment = objects["relay_deployment"]
    backendconfig = objects["relay_backendconfig"]
    if not (service_neg(service) and ingress_routes(ingress)
            and rollout_ready(deployment, pods, "relay", expected_version, env.get("GAR_REGISTRY"))
            and core_endpoints_match(service, pods, core_endpoints)
            and ready_endpoint_membership(report, service, pods, objects["relay_endpoints"],
                                          core_endpoints, slice_read=slice_read)
            and annotation(service, "cloud.google.com/backend-config") == {"default": BACKEND}
            and backendconfig["spec"]["logging"]["enable"] is False):
        return None
    project = env.get("GCP_PROJECT", "")
    name_pattern = r"[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?"
    if not isinstance(project, str) or not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
        return None
    status = annotation(service, "cloud.google.com/neg-status")
    neg, zones = status["network_endpoint_groups"]["8080"], status["zones"]
    if (not re.fullmatch(name_pattern, neg) or len(zones) != len(set(zones))
            or not all(re.fullmatch(name_pattern, z) for z in zones)
            or annotation(ingress, "ingress.kubernetes.io/backends").get(neg) != "HEALTHY"):
        return None
    pod = active_pods(pods)[0]  # Strict core membership already requires one pod/address.
    node = pod["spec"]["nodeName"]
    if not isinstance(node, str) or not re.fullmatch(name_pattern, node):
        return None
    ip = pod["status"]["podIPs"][0]["ip"]
    if str(ipaddress.IPv4Address(ip)) != ip:
        return None  # This alternative certifies the current IPv4-only topology.
    if pod["spec"]["readinessGates"].count({"conditionType": NEG_READY}) != 1:
        return None
    conditions = [c for c in pod["status"]["conditions"] if c["type"] == NEG_READY]
    if (len(conditions) != 1 or conditions[0].get("status") != "True"
            or conditions[0].get("reason") != "LoadBalancerNegWithoutHealthCheck"):
        return None
    matching_zones = []
    for zone in zones:
        key = json.dumps(f'Key{{"{neg}", zone: "{zone}"}}')
        for spacing in ("", " "):
            message = (f'Pod is in NEG {key}. NEG is not attached to any BackendService with health checking.'
                       f'{spacing}Marking condition "{NEG_READY}" to True.')
            if conditions[0].get("message") == message:
                matching_zones.append(zone)
    if len(matching_zones) != 1:
        return None
    # Fence object replacements and all routing/spec changes, not timestamps.
    resources = []
    for obj in (deployment, service, ingress, backendconfig):
        uid = obj["metadata"]["uid"]
        if not isinstance(uid, str) or not uid:
            return None
        resources.append((uid, obj["metadata"].get("generation"), obj["spec"],
                          obj["metadata"].get("annotations", {})))
    return {"project": project, "neg": neg, "zones": sorted(zones), "zone": matching_zones[0],
            "ip": ip, "node": node, "resources": resources,
            "pod": (pod["metadata"]["uid"], pod["metadata"]["name"], pod["spec"],
                    pod["status"]["containerStatuses"][0]["imageID"],
                    conditions[0]["status"], conditions[0]["reason"], conditions[0]["message"])}


def direct_health_matches(raw, target):
    """Validate the SDK's per-group get-health JSON; no aggregate is evidence."""
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate field")
            result[key] = value
        return result

    def invalid_constant(_):
        raise ValueError("non-JSON number")

    if len(raw) > 1024 * 1024:
        return False
    groups = json.loads(raw, object_pairs_hook=unique_object, parse_constant=invalid_constant)
    prefix = f'https://www.googleapis.com/compute/v1/projects/{target["project"]}/zones/'
    expected = {f'{prefix}{zone}/networkEndpointGroups/{target["neg"]}': zone for zone in target["zones"]}
    if not isinstance(groups, list) or len(groups) != len(expected):
        return False
    seen = set()
    for group in groups:
        if not isinstance(group, dict) or set(group) != {"backend", "status"}:
            return False
        uri = group["backend"]
        if not isinstance(uri, str) or uri not in expected or uri in seen:
            return False
        seen.add(uri)
        status = group["status"]
        if not isinstance(status, dict) or status.get("kind") != "compute#backendServiceGroupHealth":
            return False
        endpoints = status.get("healthStatus", [])
        if not isinstance(endpoints, list):
            return False
        if expected[uri] != target["zone"]:
            if endpoints:
                return False
            continue
        if len(endpoints) != 1 or not isinstance(endpoints[0], dict):
            return False
        endpoint = endpoints[0]
        if (endpoint.get("ipAddress") != target["ip"] or type(endpoint.get("port")) is not int
                or endpoint["port"] != 8080 or endpoint.get("healthState") != "HEALTHY"
                or endpoint.get("instance") != f'{prefix}{target["zone"]}/instances/{target["node"]}'
                or any(key in endpoint and endpoint[key] != "" for key in ("ipv6Address", "ipv6HealthState"))):
            return False
    return seen == set(expected)


def observed_neg_health(report, objects, core_endpoints, env, expected_version):
    if healthy_neg(objects["relay_service"], objects["ingress"], objects["relay_pods"]):
        return True
    target = direct_health_target(report, objects, core_endpoints, env, expected_version)
    if target is None:
        return False
    # This CLI gets only the named backend, then health for its groups. It fails
    # on partial API errors. command() captures output and applies a timeout.
    if not report.diagnostic("relay_neg_direct_backend_health", lambda: direct_health_matches(command([
            "gcloud", "compute", "backend-services", "get-health", target["neg"],
            "--project", target["project"], "--global", "--format=json", "--quiet"], env), target)):
        return False
    reads = {
        "relay_deployment": ["deployment", RELAY],
        "relay_service": ["service", RELAY],
        "ingress": ["ingress", INGRESS],
        "relay_backendconfig": ["backendconfig.cloud.google.com", BACKEND],
        "relay_pods": ["pods", "--selector=app=" + RELAY],
        "relay_endpoints": ["endpointslices.discovery.k8s.io", "--selector=kubernetes.io/service-name=" + RELAY],
        "relay_core_endpoints": ["endpoints", RELAY],
    }
    current = {key: read_object(report, "relay_health_fence_" + key, args, env, diagnostic=True)
               for key, args in reads.items()}
    return report.diagnostic("relay_neg_direct_health_current_identity", lambda:
        direct_health_target(report, current, current["relay_core_endpoints"], env, expected_version,
                             slice_read="relay_health_fence_relay_endpoints_read") == target)


def positive_neg_message(message):
    # Diagnostic parsing only: this does not relax healthy_neg's exact identity
    # gate. JSON strings cover Go's %q escaping of the resource-key strings.
    quoted = r'("(?:[^"\\\n]|\\.)*")'
    match = re.fullmatch(r'Pod has become Healthy in NEG ' + quoted
                         + r' attached to BackendService ' + quoted
                         + r'\. ?Marking condition "' + re.escape(NEG_READY) + r'" to True\.', message)
    if not match:
        return None
    return json.loads(match[1]), json.loads(match[2])


def neg_diagnostics(report, service, ingress, pods):
    def neg_status():
        return annotation(service, "cloud.google.com/neg-status")

    def neg_name():
        return neg_status()["network_endpoint_groups"]["8080"]

    def backends():
        return annotation(ingress, "ingress.kubernetes.io/backends")

    def selected():
        value = active_pods(pods)
        if not value:
            raise CheckFailure("invalid_data")
        return value

    def conditions():
        result = []
        for pod in selected():
            found = [c for c in pod["status"]["conditions"] if c["type"] == NEG_READY]
            if len(found) != 1:
                raise CheckFailure("invalid_data")
            result.append(found[0])
        return result

    report.diagnostic("relay_neg_backend_registered", lambda: neg_name() in backends())
    report.diagnostic("relay_neg_backend_healthy", lambda: backends().get(neg_name()) == "HEALTHY")
    report.diagnostic("relay_neg_pod_readiness_gate", lambda:
                      all({"conditionType": NEG_READY} in p["spec"].get("readinessGates", []) for p in selected()))
    report.diagnostic("relay_neg_pod_condition_present", lambda: bool(conditions()))
    report.diagnostic("relay_neg_pod_condition_true", lambda: all(c["status"] == "True" for c in conditions()))
    report.diagnostic("relay_neg_pod_positive_reason", lambda:
                      all(c.get("reason") == "LoadBalancerNegReady" for c in conditions()))
    report.diagnostic("relay_neg_pod_positive_message_format", lambda:
                      all(positive_neg_message(c.get("message", "")) is not None for c in conditions()))
    report.diagnostic("relay_neg_pod_message_current_identity", lambda:
                      all(c.get("message", "") in healthy_neg_messages(neg_status()) for c in conditions()))
    # Known controller reason/message branches only. Never echo unknown reason
    # strings, including future values that may contain runtime identity.
    categories = {
        "relay_neg_reason_timeout": lambda c: c.get("reason") == "LoadBalancerNegTimeout",
        "relay_neg_reason_no_health_check": lambda c: c.get("reason") == "LoadBalancerNegWithoutHealthCheck",
        "relay_neg_reason_not_ready": lambda c: c.get("reason") == "LoadBalancerNegNotReady",
        "relay_neg_reason_no_neg": lambda c: c.get("reason") == "LoadBalancerNegReady" and c.get("message", "").startswith("Pod does not belong to any NEG."),
        "relay_neg_reason_non_default_subnet": lambda c: c.get("reason") == "LoadBalancerNegReady" and c.get("message", "").startswith("Pod belongs to a node in non-default subnet."),
    }
    for name, matches in categories.items():
        report.diagnostic(name, lambda matches=matches: any(matches(c) for c in conditions()))
    report.diagnostic("relay_neg_condition_unrecognized", lambda: any(
        not any(matches(c) for matches in categories.values())
        and not (c.get("reason") == "LoadBalancerNegReady" and positive_neg_message(c.get("message", "")))
        for c in conditions()))


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


def core_endpoints_match(service, pods, endpoints):
    # Core Endpoints cannot represent dual-stack or large endpoint sets fully.
    # Only the current single-pod, single-address, single-port topology qualifies.
    if service["spec"].get("publishNotReadyAddresses", False) is not False:
        return False
    if service["spec"]["selector"] != {"app": RELAY}:
        return False
    service_ports = service["spec"]["ports"]
    if (len(service_ports) != 1 or service_ports[0]["port"] != 8080
            or service_ports[0]["targetPort"] != 8080 or service_ports[0].get("protocol", "TCP") != "TCP"):
        return False
    metadata = endpoints["metadata"]
    if metadata.get("name") != RELAY or metadata.get("namespace") != NAMESPACE:
        return False
    if "endpoints.kubernetes.io/over-capacity" in metadata.get("annotations", {}):
        return False
    selected = active_pods(pods)
    if len(selected) != 1:
        return False
    pod = selected[0]
    pod_ips = pod["status"]["podIPs"]
    if len(pod_ips) != 1 or pod["status"]["phase"] != "Running":
        return False
    pod_ip = pod_ips[0]["ip"]
    if not isinstance(pod_ip, str) or "%" in pod_ip:
        return False
    ipaddress.ip_address(pod_ip)  # Reject malformed data; never echo an address.
    ready = [c for c in pod["status"]["conditions"] if c["type"] == "Ready"]
    if len(ready) != 1 or ready[0]["status"] != "True":
        return False
    subsets = endpoints.get("subsets", [])
    if len(subsets) != 1:
        return False
    subset = subsets[0]
    if subset.get("notReadyAddresses"):
        return False
    ports = subset["ports"]
    if len(ports) != 1 or ports[0]["port"] != 8080 or ports[0].get("protocol", "TCP") != "TCP":
        return False
    addresses = subset.get("addresses", [])
    if len(addresses) != 1:
        return False  # Includes duplicate entries: no set deduplication hides extras.
    address = addresses[0]
    ref = address["targetRef"]
    uid, name = pod["metadata"]["uid"], pod["metadata"]["name"]
    return (address["ip"] == pod_ip and ref["kind"] == "Pod" and ref.get("namespace") == NAMESPACE
            and isinstance(uid, str) and bool(uid) and ref["uid"] == uid
            and isinstance(name, str) and bool(name) and ref.get("name") == name)


def ready_endpoint_membership(report, service, pods, slices, core_endpoints,
                              slice_read="relay_endpoints_read"):
    # A denied/absent Slice API can use equivalent complete core membership.
    # Timeouts, transport/auth errors, malformed data and readable mismatches
    # remain failures; never hide those by looking for a more favorable source.
    if report.failures.get(slice_read) in {"forbidden", "not_found"}:
        return core_endpoints_match(service, pods, core_endpoints)
    return endpoints_match(pods, slices)


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
        objects[key] = read_object(report, key, args, env, diagnostic=key == "relay_endpoints")
    core_endpoints = read_object(report, "relay_core_endpoints", ["endpoints", RELAY], env, diagnostic=True)
    relay, web = objects["relay_deployment"], objects["web_deployment"]
    service, ingress, pods = objects["relay_service"], objects["ingress"], objects["relay_pods"]
    report.check("relay_rollout_and_image", lambda: rollout_ready(relay, pods, "relay", expected_version, env.get("GAR_REGISTRY")))
    report.check("web_rollout_and_image", lambda: rollout_ready(web, objects["web_pods"], "web", expected_version, env.get("GAR_REGISTRY")))
    report.check("ingress_gce_relay_routes", lambda: ingress_routes(ingress))
    report.check("relay_service_ingress_neg", lambda: service_neg(service))
    report.check("relay_neg_observed_healthy", lambda:
                 observed_neg_health(report, objects, core_endpoints, env, expected_version))
    neg_diagnostics(report, service, ingress, pods)
    report.check("relay_ready_endpoints_match_pods", lambda:
                 ready_endpoint_membership(report, service, pods, objects["relay_endpoints"], core_endpoints))
    report.diagnostic("relay_membership_uses_core_api", lambda:
                      report.failures.get("relay_endpoints_read") in {"forbidden", "not_found"})
    report.diagnostic("relay_core_endpoints_match_pods", lambda: core_endpoints_match(service, pods, core_endpoints))
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
