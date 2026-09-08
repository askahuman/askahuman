"""Deterministic topology, redaction and public-probe regressions; no live APIs."""
import contextlib
import copy
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from email.message import Message
from unittest.mock import patch

import production_preflight as p
import verify_public_release as public

RELEASE = "1.2.3"
SHA = "0123456789012345678901234567890123456789"
PRIVATE = "private-project-registry-token-DO-NOT-PRINT"
NEG = "k8s1-private-ask-a-human-relay-8080-hash"
ZONE = "private-zone"


def fixtures():
    result = {}
    for name in ("relay", "web"):
        image = f"{PRIVATE}/{name}:{RELEASE}"
        container = {"name": name, "image": image}
        result[name + "_deployment"] = {
            "metadata": {"generation": 3},
            "spec": {"replicas": 1, "template": {"spec": {"containers": [container]}}},
            "status": {"observedGeneration": 3, "replicas": 1, "updatedReplicas": 1,
                       "readyReplicas": 1, "availableReplicas": 1},
        }
        message = (f'Pod has become Healthy in NEG {json.dumps(f"Key{{\"{NEG}\", zone: \"{ZONE}\"}}")}'
                   f' attached to BackendService {json.dumps(f"Key{{\"{NEG}\"}}")}. '
                   f'Marking condition "{p.NEG_READY}" to True.')
        result[name + "_pods"] = {"items": [{
            "metadata": {"uid": name + "-uid", "name": name + "-pod"},
            "spec": {"containers": [copy.deepcopy(container)], "readinessGates": [{"conditionType": p.NEG_READY}]},
            "status": {"phase": "Running", "podIPs": [{"ip": "10.0.0.9"}],
                       "conditions": [{"type": "Ready", "status": "True"},
                                      {"type": p.NEG_READY, "status": "True", "reason": "LoadBalancerNegReady", "message": message}],
                       "containerStatuses": [{"name": name, "ready": True, "imageID": PRIVATE + "/sha256:abcdef"}]},
        }]}
    result["relay_service"] = {
        "metadata": {"annotations": {
            "cloud.google.com/neg": '{"ingress":true}',
            "cloud.google.com/neg-status": json.dumps({"network_endpoint_groups": {"8080": NEG}, "zones": [ZONE]}),
            "cloud.google.com/backend-config": json.dumps({"default": p.BACKEND}),
        }},
        "spec": {"type": "ClusterIP", "selector": {"app": p.RELAY}, "ports": [{"port": 8080, "targetPort": 8080}]},
    }
    result["ingress"] = {
        "metadata": {"annotations": {"kubernetes.io/ingress.class": "gce", "ingress.kubernetes.io/backends": json.dumps({NEG: "HEALTHY"})}},
        "status": {"loadBalancer": {"ingress": [{"ip": "203.0.113.9"}]}},
        "spec": {"rules": [{"host": "ask-a-human.ai", "http": {"paths": [
            {"path": path, "pathType": "Prefix", "backend": {"service": {"name": p.RELAY, "port": {"number": 8080}}}}
            for path in ("/ws", "/healthz")
        ]}}]},
    }
    result["relay_backendconfig"] = {"spec": {"logging": {"enable": False}}}
    result["relay_endpoints"] = {"items": [{"ports": [{"port": 8080, "protocol": "TCP"}], "endpoints": [{
        "conditions": {"ready": True}, "addresses": ["10.0.0.9"],
        "targetRef": {"kind": "Pod", "uid": "relay-uid", "namespace": p.NAMESPACE},
    }]}]}
    result["relay_core_endpoints"] = {"metadata": {"name": p.RELAY, "namespace": p.NAMESPACE},
        "subsets": [{"ports": [{"port": 8080, "protocol": "TCP"}],
        "addresses": [{"ip": "10.0.0.9", "targetRef": {"kind": "Pod", "uid": "relay-uid", "name": "relay-pod", "namespace": p.NAMESPACE}}]}]}
    return result


class ClusterTests(unittest.TestCase):
    def run_cluster(self, data):
        output = io.StringIO()
        report = p.Report()
        with contextlib.redirect_stdout(output), patch.object(p, "read_object", side_effect=lambda _, key, *args, **kwargs: data[key]):
            p.check_cluster(report, {"GAR_REGISTRY": PRIVATE})
        self.assertNotIn(PRIVATE, output.getvalue())
        self.assertNotIn(NEG, output.getvalue())
        return report.ok, {x.get("check", x.get("diagnostic")): x["ok"] for x in map(json.loads, output.getvalue().splitlines())}

    def test_healthy_current_cluster_and_versioned_images(self):
        data = fixtures()
        self.assertTrue(self.run_cluster(data)[0])
        self.assertTrue(p.rollout_ready(data["relay_deployment"], data["relay_pods"], "relay", RELEASE, PRIVATE))
        self.assertFalse(p.rollout_ready(data["relay_deployment"], data["relay_pods"], "relay", "1.2.4", PRIVATE))

    def test_neg_true_without_positive_health_observation_is_rejected(self):
        for reason, message in [
            ("LoadBalancerNegTimeout", "Timeout waiting for pod to become healthy"),
            ("LoadBalancerNegWithoutHealthCheck", "NEG is not attached to any BackendService with health checking"),
            ("LoadBalancerNegReady", "Pod does not belong to any NEG"),
            ("LoadBalancerNegReady", "Pod belongs to a node in non-default subnet"),
            ("LoadBalancerNegReady", "private arbitrary text"),
        ]:
            with self.subTest(reason=reason, message=message):
                data = fixtures()
                data["relay_pods"]["items"][0]["status"]["conditions"][1].update(reason=reason, message=message)
                ok, checks = self.run_cluster(data)
                self.assertFalse(ok)
                self.assertFalse(checks["relay_neg_observed_healthy"])

    def test_legacy_healthy_message_spacing_supported(self):
        data = fixtures()
        condition = data["relay_pods"]["items"][0]["status"]["conditions"][1]
        condition["message"] = condition["message"].replace(". Marking", ".Marking")
        self.assertTrue(self.run_cluster(data)[0])

    def test_wrong_neg_zone_backend_or_ready_endpoint_rejected(self):
        for token in (NEG, ZONE, 'BackendService'):
            data = fixtures()
            c = data["relay_pods"]["items"][0]["status"]["conditions"][1]
            c["message"] = c["message"].replace(token, "wrong")
            self.assertFalse(self.run_cluster(data)[0])
        for field, value in [("addresses", ["10.0.0.10"]), ("conditions", {"ready": False}),
                             ("targetRef", {"kind": "Pod", "uid": "different", "namespace": p.NAMESPACE})]:
            data = fixtures()
            data["relay_endpoints"]["items"][0]["endpoints"][0][field] = value
            self.assertFalse(self.run_cluster(data)[0])

    def test_rollout_ingress_service_and_logging_drift_rejected(self):
        mutations = [
            lambda d: d["relay_deployment"]["status"].update(updatedReplicas=0),
            lambda d: d["relay_deployment"]["status"].update(observedGeneration=2),
            lambda d: d["relay_pods"]["items"][0]["spec"]["containers"].append({"name": "proxy", "image": "other"}),
            lambda d: d["relay_pods"]["items"][0]["spec"]["containers"][0].update(image="old"),
            lambda d: d["relay_pods"]["items"][0]["status"]["containerStatuses"][0].update(imageID=""),
            lambda d: d["relay_service"]["metadata"]["annotations"].update({"cloud.google.com/neg": '{"ingress":false}'}),
            lambda d: d["relay_service"]["spec"].update(type="NodePort"),
            lambda d: d["ingress"]["metadata"]["annotations"].update({"kubernetes.io/ingress.class": "gce-internal"}),
            lambda d: d["ingress"]["metadata"]["annotations"].update({"ingress.kubernetes.io/backends": json.dumps({NEG: "UNHEALTHY"})}),
            lambda d: d["relay_backendconfig"]["spec"]["logging"].update(enable=True),
        ]
        for mutate in mutations:
            data = fixtures()
            mutate(data)
            self.assertFalse(self.run_cluster(data)[0])

    def test_failed_cli_and_malformed_json_are_redacted(self):
        failures = [subprocess.TimeoutExpired(["kubectl", PRIVATE], 1, output=PRIVATE, stderr=PRIVATE),
                    RuntimeError(PRIVATE)]
        for failure in failures:
            out = io.StringIO()
            with contextlib.redirect_stdout(out), patch.object(p, "command", side_effect=failure):
                self.assertEqual(p.read_object(p.Report(), "relay_pods", ["pods"], {}), {})
            self.assertEqual(json.loads(out.getvalue()), {"check": "relay_pods_read", "ok": False,
                             "failure": "timeout" if isinstance(failure, subprocess.TimeoutExpired) else "unknown_error"})
        with contextlib.redirect_stdout(io.StringIO()), patch.object(p, "command", return_value="["):
            report = p.Report()
            self.assertEqual(p.read_object(report, "ingress", ["ingress"], {}), {})
            self.assertFalse(report.ok)

    def test_cli_refuses_ambient_context_and_isolates_runner_config(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(p, "command") as run, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(p.main(), 1)
            run.assert_not_called()
        with tempfile.TemporaryDirectory() as directory:
            env = {"GITHUB_ACTIONS": "true", "RUNNER_TEMP": directory, "GCP_PROJECT": PRIVATE,
                   "GKE_CLUSTER": PRIVATE, "KUBECONFIG": "/do-not-touch-existing-config"}
            with patch.dict(os.environ, env, clear=True), patch.object(p, "command", return_value="") as run, \
                    patch.object(p, "check_cluster"), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(p.main(), 0)
                args, call_env = run.call_args.args
                self.assertEqual(args[:5], ["gcloud", "container", "fleet", "memberships", "get-credentials"])
                self.assertTrue(call_env["KUBECONFIG"].startswith(directory + "/aah-preflight-"))
                self.assertFalse(os.path.exists(call_env["KUBECONFIG"]))

    def test_neg_diagnostics_distinguish_backend_health_format_and_identity(self):
        data = fixtures()
        ok, checks = self.run_cluster(data)
        self.assertTrue(ok)
        for key in ("backend_registered", "backend_healthy", "pod_readiness_gate", "pod_condition_present",
                    "pod_condition_true", "pod_positive_reason", "pod_positive_message_format", "pod_message_current_identity"):
            self.assertTrue(checks["relay_neg_" + key], key)
        self.assertFalse(checks["relay_neg_condition_unrecognized"])
        data["ingress"]["metadata"]["annotations"]["ingress.kubernetes.io/backends"] = json.dumps({NEG: "UNHEALTHY"})
        ok, checks = self.run_cluster(data)
        self.assertFalse(ok)
        self.assertTrue(checks["relay_neg_backend_registered"])
        self.assertFalse(checks["relay_neg_backend_healthy"])
        self.assertTrue(checks["relay_neg_pod_message_current_identity"])
        data = fixtures()
        condition = data["relay_pods"]["items"][0]["status"]["conditions"][1]
        condition["message"] = condition["message"].replace(NEG, "another-private-neg")
        ok, checks = self.run_cluster(data)
        self.assertFalse(ok)
        self.assertTrue(checks["relay_neg_pod_positive_message_format"])
        self.assertFalse(checks["relay_neg_pod_message_current_identity"])
        condition["message"] = PRIVATE
        ok, checks = self.run_cluster(data)
        self.assertFalse(ok)
        self.assertFalse(checks["relay_neg_pod_positive_message_format"])
        self.assertTrue(checks["relay_neg_condition_unrecognized"])

    def test_neg_known_reason_categories_do_not_relax_gate(self):
        cases = [("LoadBalancerNegTimeout", PRIVATE, "timeout"),
                 ("LoadBalancerNegWithoutHealthCheck", PRIVATE, "no_health_check"),
                 ("LoadBalancerNegNotReady", PRIVATE, "not_ready"),
                 ("LoadBalancerNegReady", "Pod does not belong to any NEG. " + PRIVATE, "no_neg"),
                 ("LoadBalancerNegReady", "Pod belongs to a node in non-default subnet. " + PRIVATE, "non_default_subnet")]
        for reason, message, category in cases:
            data = fixtures()
            data["relay_pods"]["items"][0]["status"]["conditions"][1].update(reason=reason, message=message)
            ok, checks = self.run_cluster(data)
            self.assertFalse(ok)
            self.assertTrue(checks["relay_neg_reason_" + category])
            self.assertFalse(checks["relay_neg_observed_healthy"])
            self.assertFalse(checks["relay_neg_condition_unrecognized"])

    def test_missing_neg_gate_or_condition_remains_a_failure(self):
        data = fixtures()
        data["relay_pods"]["items"][0]["spec"].pop("readinessGates")
        ok, checks = self.run_cluster(data)
        self.assertFalse(ok)
        self.assertFalse(checks["relay_neg_pod_readiness_gate"])
        self.assertTrue(checks["relay_neg_pod_condition_present"])
        data = fixtures()
        data["relay_pods"]["items"][0]["status"]["conditions"].pop()
        ok, checks = self.run_cluster(data)
        self.assertFalse(ok)
        self.assertFalse(checks["relay_neg_pod_condition_present"])

    def test_core_endpoints_do_not_hide_missing_data_or_affect_readable_slices(self):
        data = fixtures()
        data["relay_endpoints"] = {}
        ok, checks = self.run_cluster(data)
        self.assertFalse(ok, "readable core Endpoints cannot bypass the required EndpointSlice check")
        self.assertTrue(checks["relay_core_endpoints_match_pods"])
        for mutation in [lambda e: e["metadata"].update(annotations={"endpoints.kubernetes.io/over-capacity": "truncated"}),
                         lambda e: e["subsets"][0].update(notReadyAddresses=[{"ip": "10.0.0.9"}]),
                         lambda e: e["subsets"][0]["addresses"][0].update(ip="10.0.0.10"),
                         lambda e: e["subsets"][0]["addresses"][0]["targetRef"].update(uid="wrong")]:
            data = fixtures()
            mutation(data["relay_core_endpoints"])
            ok, checks = self.run_cluster(data)
            self.assertTrue(ok, "diagnostic-only legacy API does not change the existing gate")
            self.assertFalse(checks["relay_core_endpoints_match_pods"])
        output = io.StringIO()
        report = p.Report()
        with patch.object(p, "command", side_effect=p.CheckFailure("forbidden")), contextlib.redirect_stdout(output):
            p.read_object(report, "relay_core_endpoints", ["endpoints", p.RELAY], {}, diagnostic=True)
        self.assertTrue(report.ok)
        self.assertEqual(json.loads(output.getvalue()), {"diagnostic": "relay_core_endpoints_read", "ok": False, "failure": "forbidden"})


class DirectNegHealthTests(unittest.TestCase):
    """The historical condition is never evidence without a fresh exact check."""
    PROJECT = "synthetic-project"
    NODE = "synthetic-node"

    def data(self, zones=("test-zone-a",)):
        data = fixtures()
        for key in ("relay_deployment", "relay_service", "ingress", "relay_backendconfig"):
            data[key].setdefault("metadata", {})["uid"] = key + "-uid"
        data["relay_service"]["metadata"]["annotations"]["cloud.google.com/neg-status"] = json.dumps(
            {"network_endpoint_groups": {"8080": NEG}, "zones": list(zones)})
        pod = data["relay_pods"]["items"][0]
        pod["spec"]["nodeName"] = self.NODE
        pod["status"]["conditions"][1].update(
            reason="LoadBalancerNegWithoutHealthCheck",
            message=(f'Pod is in NEG {json.dumps(f"Key{{\"{NEG}\", zone: \"{zones[0]}\"}}")}. '
                     'NEG is not attached to any BackendService with health checking. '
                     f'Marking condition "{p.NEG_READY}" to True.'))
        return data

    def health(self, zones=("test-zone-a",)):
        prefix = f"https://www.googleapis.com/compute/v1/projects/{self.PROJECT}/zones/"
        return [{"backend": f"{prefix}{zone}/networkEndpointGroups/{NEG}",
                 "status": {"kind": "compute#backendServiceGroupHealth", "healthStatus": [{
                     "ipAddress": "10.0.0.9", "port": 8080, "healthState": "HEALTHY",
                     "instance": f"{prefix}{zone}/instances/{self.NODE}"}] if index == 0 else []}}
                for index, zone in enumerate(zones)]

    def run_check(self, data=None, health=None, fence=None, first_slice_error=None, fence_slice_error=None,
                  health_error=None, env=None, fence_error=None):
        data = data if data is not None else self.data()
        fence = fence if fence is not None else copy.deepcopy(data)
        initial_keys = ("relay_deployment", "web_deployment", "relay_service", "ingress", "relay_backendconfig",
                        "relay_pods", "web_pods", "relay_endpoints", "relay_core_endpoints")
        fence_keys = ("relay_deployment", "relay_service", "ingress", "relay_backendconfig", "relay_pods", "relay_endpoints", "relay_core_endpoints")
        responses = [json.dumps(data[k]) for k in initial_keys]
        if first_slice_error:
            responses[7] = p.CheckFailure(first_slice_error)
        responses.append(health_error if health_error is not None else json.dumps(self.health() if health is None else health))
        for key in fence_keys:
            if key == "relay_endpoints" and fence_slice_error:
                responses.append(p.CheckFailure(fence_slice_error))
            elif key == fence_error:
                responses.append(p.CheckFailure("forbidden"))
            else:
                responses.append(json.dumps(fence[key]))
        output = io.StringIO()
        report = p.Report()
        env = env if env is not None else {"GCP_PROJECT": self.PROJECT, "GAR_REGISTRY": PRIVATE}
        with patch.object(p, "command", side_effect=responses) as calls, contextlib.redirect_stdout(output):
            p.check_cluster(report, env)
        for private in (PRIVATE, NEG, self.PROJECT, self.NODE, "10.0.0.9", "test-zone-a"):
            self.assertNotIn(private, output.getvalue())
        records = {r.get("check", r.get("diagnostic")): r for r in map(json.loads, output.getvalue().splitlines())}
        return report.ok, records, [call.args[0] for call in calls.call_args_list]

    def test_historical_condition_needs_exact_current_health_and_fence(self):
        for slice_error in (None, "forbidden", "not_found"):
            with self.subTest(slice_error=slice_error):
                ok, records, calls = self.run_check(first_slice_error=slice_error, fence_slice_error=slice_error)
                self.assertTrue(ok)
                self.assertTrue(records["relay_neg_observed_healthy"]["ok"])
                self.assertTrue(records["relay_neg_direct_backend_health"]["ok"])
                self.assertTrue(records["relay_neg_direct_health_current_identity"]["ok"])
                self.assertTrue(records["relay_neg_reason_no_health_check"]["ok"])
                self.assertFalse(records["relay_neg_pod_positive_reason"]["ok"])
                self.assertEqual([c for c in calls if c[0] == "gcloud"], [[
                    "gcloud", "compute", "backend-services", "get-health", NEG,
                    "--project", self.PROJECT, "--global", "--format=json", "--quiet"]])
                self.assertEqual(len(calls), 17)

    def test_declared_empty_zones_are_not_evidence_or_unknown_groups(self):
        zones = ("test-zone-a", "test-zone-b")
        data, health = self.data(zones), self.health(zones)
        self.assertTrue(self.run_check(data, health)[0])
        for mutate in [lambda h: h.pop(), lambda h: h.append(copy.deepcopy(h[0])),
                       lambda h: h[1].update(backend=h[0]["backend"]),
                       lambda h: h[1]["status"].update(healthStatus=copy.deepcopy(h[0]["status"]["healthStatus"])),
                       lambda h: h[0]["status"].update(healthStatus=[]),
                       lambda h: h[1]["status"].update(healthStatus=None)]:
            broken = copy.deepcopy(health)
            mutate(broken)
            self.assertFalse(self.run_check(data, broken)[0])

    def test_wrong_endpoint_or_group_cannot_be_hidden_by_a_healthy_record(self):
        mutations = [
            lambda h: h[0].update(backend=h[0]["backend"].replace(self.PROJECT, "another-project")),
            lambda h: h[0].update(backend=h[0]["backend"].replace("test-zone-a", "test-zone-b")),
            lambda h: h[0].update(backend=h[0]["backend"].replace(NEG, "another-neg")),
            lambda h: h[0].update(backend=h[0]["backend"].replace("https://", "http://")),
            lambda h: h[0]["status"]["healthStatus"].append(copy.deepcopy(h[0]["status"]["healthStatus"][0])),
            lambda h: h[0]["status"].update(healthStatus=[]),
        ]
        for field, value in [("ipAddress", "10.0.0.10"), ("port", 80), ("port", "8080"), ("port", True),
                             ("healthState", "UNHEALTHY"), ("healthState", "UNKNOWN"),
                             ("instance", "another-node"), ("ipv6Address", "2001:db8::1"), ("ipv6HealthState", "HEALTHY"),
                             ("ipv6Address", None), ("ipv6HealthState", False), ("ipv6HealthState", "UNSPECIFIED")]:
            mutations.append(lambda h, f=field, v=value: h[0]["status"]["healthStatus"][0].update({f: v}))
        for token in (self.NODE, self.PROJECT, "test-zone-a"):
            mutations.append(lambda h, token=token: h[0]["status"]["healthStatus"][0].update(
                instance=h[0]["status"]["healthStatus"][0]["instance"].replace(token, "wrong")))
        for mutate in mutations:
            health = self.health()
            mutate(health)
            ok, _, calls = self.run_check(health=health)
            self.assertFalse(ok)
            self.assertEqual(len(calls), 10, "bad health must not proceed to the acceptance fence")

    def test_malformed_missing_or_partial_health_fails_closed_and_redacted(self):
        for health in ({}, False, [], [None], [{"backend": NEG}],
                       [{"backend": self.health()[0]["backend"], "status": None}]):
            self.assertFalse(self.run_check(health=health)[0])
        for field, value in [("kind", "wrong"), ("healthStatus", None), ("healthStatus", {}), ("healthStatus", [None])]:
            health = self.health()
            health[0]["status"][field] = value
            self.assertFalse(self.run_check(health=health)[0])
        target = {"project": self.PROJECT, "neg": NEG, "zones": ["test-zone-a"], "zone": "test-zone-a",
                  "ip": "10.0.0.9", "node": self.NODE}
        with self.assertRaises(ValueError):
            p.direct_health_matches(json.dumps(self.health()).replace('"port": 8080', '"port": 80, "port": 8080'), target)
        with self.assertRaises(ValueError):
            p.direct_health_matches(json.dumps(self.health()).replace('"port": 8080', '"port": NaN'), target)
        self.assertFalse(p.direct_health_matches(" " * (1024 * 1024 + 1), target))
        for error, category in [(p.CheckFailure("forbidden"), "forbidden"), (p.CheckFailure("not_found"), "not_found"),
                                (p.CheckFailure("unavailable"), "unavailable"),
                                (subprocess.TimeoutExpired(["gcloud", PRIVATE], 45, output=PRIVATE, stderr=PRIVATE), "timeout"),
                                (RuntimeError(PRIVATE), "unknown_error"), ("{", "invalid_json")]:
            ok, records, _ = self.run_check(health_error=error)
            self.assertFalse(ok)
            self.assertEqual(records["relay_neg_direct_backend_health"]["failure"], category)

    def test_only_exact_historical_message_with_complete_membership_can_query_compute(self):
        mutations = [
            lambda d: d["relay_pods"]["items"][0]["status"]["conditions"][1].update(reason="LoadBalancerNegTimeout"),
            lambda d: d["relay_pods"]["items"][0]["status"]["conditions"][1].update(reason="unknown"),
            lambda d: d["relay_pods"]["items"][0]["status"]["conditions"][1].update(status="False"),
            lambda d: d["relay_pods"]["items"][0]["status"]["conditions"][1].update(message=PRIVATE),
            lambda d: d["relay_pods"]["items"][0]["spec"].update(nodeName="--help"),
            lambda d: d["relay_pods"]["items"][0]["spec"].update(readinessGates=[]),
            lambda d: d["relay_core_endpoints"]["subsets"][0]["addresses"][0]["targetRef"].update(uid="old-pod"),
            lambda d: d["relay_endpoints"]["items"][0]["endpoints"][0].update(conditions={"ready": False}),
        ]
        for mutate in mutations:
            data = self.data()
            mutate(data)
            ok, _, calls = self.run_check(data)
            self.assertFalse(ok)
            self.assertFalse(any(c[0] == "gcloud" for c in calls))
        for project in (None, "", "--help", "other/project", "project\nprivate", "UPPERCASE", PRIVATE):
            ok, _, calls = self.run_check(env={"GAR_REGISTRY": PRIVATE, "GCP_PROJECT": project})
            self.assertFalse(ok)
            self.assertFalse(any(c[0] == "gcloud" for c in calls))
        for data in (fixtures(),):
            ok, _, calls = self.run_check(data)
            self.assertTrue(ok)
            self.assertFalse(any(c[0] == "gcloud" for c in calls), "existing positive path remains unchanged")

    def test_rollover_or_routing_change_during_health_read_is_rejected(self):
        mutations = [
            lambda d: d["relay_pods"]["items"][0]["metadata"].update(uid="replacement-same-ip"),
            lambda d: d["relay_pods"]["items"][0]["spec"].update(nodeName="replacement-node"),
            lambda d: d["relay_pods"]["items"][0]["status"]["podIPs"][0].update(ip="10.0.0.10"),
            lambda d: d["relay_pods"]["items"][0]["status"]["conditions"][0].update(status="False"),
            lambda d: d["relay_pods"]["items"][0]["status"]["conditions"][1].update(message=PRIVATE),
            lambda d: d["relay_pods"]["items"][0]["spec"].update(readinessGates=[]),
            lambda d: d["relay_service"]["metadata"].update(uid="replacement-service"),
            lambda d: d["ingress"]["metadata"].update(uid="replacement-ingress"),
            lambda d: d["relay_deployment"]["metadata"].update(uid="replacement-deployment"),
            lambda d: d["relay_backendconfig"]["metadata"].update(uid="replacement-backendconfig"),
            lambda d: d["relay_backendconfig"]["spec"].update(healthCheck={"port": 9999}),
            lambda d: d["relay_backendconfig"]["spec"]["logging"].update(enable=True),
            lambda d: d["ingress"]["spec"]["rules"][0]["http"]["paths"][0].update(path="/other"),
            lambda d: d["relay_core_endpoints"]["subsets"][0]["addresses"].append(
                copy.deepcopy(d["relay_core_endpoints"]["subsets"][0]["addresses"][0])),
            lambda d: d["relay_endpoints"]["items"][0]["endpoints"][0].update(conditions={"ready": False}),
        ]
        for mutate in mutations:
            fence = self.data()
            mutate(fence)
            ok, records, _ = self.run_check(fence=fence)
            self.assertFalse(ok)
            self.assertTrue(records["relay_neg_direct_backend_health"]["ok"])
            self.assertFalse(records["relay_neg_direct_health_current_identity"]["ok"])
        for key in ("relay_deployment", "relay_service", "ingress", "relay_backendconfig", "relay_pods", "relay_core_endpoints"):
            self.assertFalse(self.run_check(fence_error=key)[0])
        for error in ("timeout", "unauthenticated", "unavailable", "invalid_json"):
            self.assertFalse(self.run_check(first_slice_error=error)[0])
            self.assertFalse(self.run_check(first_slice_error="forbidden", fence_slice_error=error)[0])
        self.assertTrue(self.run_check(first_slice_error="forbidden")[0], "new readable slices are independently checked")

    def test_standard_compute_permission_error_is_closed_forbidden_category(self):
        denied = subprocess.CompletedProcess([], 1, "", f"ERROR: Required 'compute.backendServices.get' permission for '{PRIVATE}'")
        with patch.object(p.subprocess, "run", return_value=denied), self.assertRaises(p.CheckFailure) as result:
            p.command(["gcloud", "compute", "backend-services", "get-health", PRIVATE], {})
        self.assertEqual(result.exception.category, "forbidden")
        self.assertNotIn(PRIVATE, str(result.exception))


class EndpointMembershipTests(unittest.TestCase):
    def run_preflight(self, data, slice_error=None, core_error=None):
        keys = ("relay_deployment", "web_deployment", "relay_service", "ingress", "relay_backendconfig",
                "relay_pods", "web_pods", "relay_endpoints", "relay_core_endpoints")
        responses = [json.dumps(data[k]) for k in keys]
        if slice_error:
            responses[7] = p.CheckFailure(slice_error)
        if core_error:
            responses[8] = p.CheckFailure(core_error)
        output = io.StringIO()
        report = p.Report()
        with patch.object(p, "command", side_effect=responses), contextlib.redirect_stdout(output):
            p.check_cluster(report, {"GAR_REGISTRY": PRIVATE})
        self.assertNotIn(PRIVATE, output.getvalue())
        self.assertNotIn(NEG, output.getvalue())
        rows = [json.loads(line) for line in output.getvalue().splitlines()]
        return report.ok, {row.get("check", row.get("diagnostic")): row for row in rows}

    def test_only_explicit_forbidden_or_not_found_selects_complete_core_membership(self):
        for error in ("forbidden", "not_found"):
            ok, checks = self.run_preflight(fixtures(), error)
            self.assertTrue(ok)
            self.assertEqual(checks["relay_endpoints_read"]["failure"], error)
            self.assertIn("diagnostic", checks["relay_endpoints_read"])
            self.assertTrue(checks["relay_membership_uses_core_api"]["ok"])
            self.assertTrue(checks["relay_ready_endpoints_match_pods"]["ok"])
        for error in p.FAILURE_CLASSES - {"forbidden", "not_found"}:
            ok, checks = self.run_preflight(fixtures(), error)
            self.assertFalse(ok)
            self.assertFalse(checks["relay_membership_uses_core_api"]["ok"])
            self.assertFalse(checks["relay_ready_endpoints_match_pods"]["ok"])

    def test_core_source_cannot_hide_readable_bad_slices_or_unavailable_core(self):
        data = fixtures()
        data["relay_endpoints"]["items"][0]["endpoints"][0]["addresses"] = ["10.0.0.10"]
        ok, checks = self.run_preflight(data)
        self.assertFalse(ok)
        self.assertFalse(checks["relay_membership_uses_core_api"]["ok"])
        self.assertTrue(checks["relay_core_endpoints_match_pods"]["ok"])
        for error in ("forbidden", "not_found", "timeout", "invalid_json"):
            ok, checks = self.run_preflight(fixtures(), "forbidden", error)
            self.assertFalse(ok)
            self.assertFalse(checks["relay_ready_endpoints_match_pods"]["ok"])

    def test_core_requires_exact_single_pod_address_uid_name_and_tcp_port(self):
        mutations = [
            lambda d: d["relay_core_endpoints"]["metadata"].update(name="other"),
            lambda d: d["relay_core_endpoints"]["metadata"].update(namespace="other"),
            lambda d: d["relay_core_endpoints"]["metadata"].update(annotations={"endpoints.kubernetes.io/over-capacity": "truncated"}),
            lambda d: d["relay_core_endpoints"]["subsets"][0]["addresses"].append(copy.deepcopy(d["relay_core_endpoints"]["subsets"][0]["addresses"][0])),
            lambda d: d["relay_core_endpoints"]["subsets"].append(copy.deepcopy(d["relay_core_endpoints"]["subsets"][0])),
            lambda d: d["relay_core_endpoints"]["subsets"][0].update(notReadyAddresses=[{"ip": "10.0.0.9"}]),
            lambda d: d["relay_core_endpoints"]["subsets"][0]["ports"].append({"port": 8081, "protocol": "TCP"}),
            lambda d: d["relay_core_endpoints"]["subsets"][0]["ports"][0].update(port=8081),
            lambda d: d["relay_core_endpoints"]["subsets"][0]["ports"][0].update(protocol="UDP"),
            lambda d: d["relay_core_endpoints"]["subsets"][0]["addresses"][0].update(ip="10.0.0.10"),
            lambda d: d["relay_core_endpoints"]["subsets"][0]["addresses"][0]["targetRef"].update(uid="wrong"),
            lambda d: d["relay_core_endpoints"]["subsets"][0]["addresses"][0]["targetRef"].update(name="wrong"),
            lambda d: d["relay_core_endpoints"]["subsets"][0]["addresses"][0]["targetRef"].update(namespace="wrong"),
            lambda d: d["relay_core_endpoints"]["subsets"][0]["addresses"][0]["targetRef"].update(kind="Node"),
            lambda d: d["relay_pods"]["items"].append(copy.deepcopy(d["relay_pods"]["items"][0])),
            lambda d: d["relay_pods"]["items"][0]["status"]["podIPs"].append({"ip": "2001:db8::9"}),
            lambda d: d["relay_pods"]["items"][0]["status"]["conditions"][0].update(status="False"),
            lambda d: d["relay_pods"]["items"][0]["status"].update(phase="Pending"),
            lambda d: d["relay_service"]["spec"].update(publishNotReadyAddresses=True),
            lambda d: d["relay_service"]["spec"]["ports"].append({"port": 8081, "targetPort": 8081}),
        ]
        for mutate in mutations:
            data = fixtures()
            mutate(data)
            ok, checks = self.run_preflight(data, "forbidden")
            self.assertFalse(ok)
            self.assertFalse(checks["relay_ready_endpoints_match_pods"]["ok"])

    def test_single_stack_ipv6_is_complete_but_malformed_or_scoped_addresses_fail(self):
        for address, expected in [("2001:db8::9", True), ("invalid", False), ("fe80::9%eth0", False)]:
            data = fixtures()
            data["relay_pods"]["items"][0]["status"]["podIPs"][0]["ip"] = address
            data["relay_core_endpoints"]["subsets"][0]["addresses"][0]["ip"] = address
            ok, checks = self.run_preflight(data, "forbidden")
            self.assertEqual(checks["relay_ready_endpoints_match_pods"]["ok"], expected)
            self.assertEqual(ok, expected)

    def test_current_no_health_check_condition_still_blocks_release(self):
        data = fixtures()
        data["relay_pods"]["items"][0]["status"]["conditions"][1].update(
            reason="LoadBalancerNegWithoutHealthCheck", message="known historical condition " + PRIVATE)
        ok, checks = self.run_preflight(data, "forbidden")
        self.assertFalse(ok)
        self.assertTrue(checks["relay_ready_endpoints_match_pods"]["ok"])
        self.assertTrue(checks["relay_neg_backend_healthy"]["ok"])
        self.assertTrue(checks["relay_neg_reason_no_health_check"]["ok"])
        self.assertFalse(checks["relay_neg_observed_healthy"]["ok"])


class DiagnosticRedactionTests(unittest.TestCase):
    def test_known_command_errors_are_fixed_categories(self):
        cases = [
            ("Error from server (Forbidden): " + PRIVATE, "forbidden"),
            ("Error from server (NotFound): " + PRIVATE, "not_found"),
            ("Error from server (Unauthorized): " + PRIVATE, "unauthenticated"),
            ("Error from server (ServiceUnavailable): " + PRIVATE, "unavailable"),
            ("Error from server (TooManyRequests): " + PRIVATE, "rate_limited"),
            ("Error from server (BadRequest): " + PRIVATE, "invalid_request"),
            ("Error from server (InternalError): " + PRIVATE, "api_error"),
            ("ERROR: PERMISSION_DENIED " + PRIVATE, "forbidden"),
            ("error: the server doesn't have a resource type " + PRIVATE, "not_found"),
            ("Unable to connect to the server: " + PRIVATE + " i/o timeout", "timeout"),
            ("Unable to connect to the server: " + PRIVATE + " context deadline exceeded", "timeout"),
            ("Unable to connect to the server: " + PRIVATE + " x509: untrusted", "tls_error"),
            ("Unable to connect to the server: " + PRIVATE + " connection refused", "network_error"),
            (PRIVATE, "tool_error"),
        ]
        for raw, category in cases:
            with self.subTest(category=category):
                completed = subprocess.CompletedProcess(["kubectl", PRIVATE], 1, stdout=PRIVATE, stderr=raw)
                output = io.StringIO()
                with patch.object(p.subprocess, "run", return_value=completed), contextlib.redirect_stdout(output):
                    report = p.Report()
                    report.check("api_read", lambda: p.command(["kubectl", PRIVATE], {}))
                self.assertFalse(report.ok)
                self.assertEqual(json.loads(output.getvalue()), {"check": "api_read", "ok": False, "failure": category})

    def test_structured_api_status_and_local_failures_are_redacted(self):
        for raw in (json.dumps({"kind": "Status", "reason": "Forbidden", "message": PRIVATE}),
                    json.dumps({"kind": "Status", "reason": PRIVATE, "message": PRIVATE})):
            self.assertEqual(p.command_failure(raw, ""), "forbidden" if '"Forbidden"' in raw else "api_error")
        for error, category in [(subprocess.TimeoutExpired([PRIVATE], 45, output=PRIVATE, stderr=PRIVATE), "timeout"),
                                (FileNotFoundError(PRIVATE), "tool_unavailable"), (PermissionError(PRIVATE), "tool_error")]:
            with patch.object(p.subprocess, "run", side_effect=error):
                with self.assertRaises(p.CheckFailure) as caught:
                    p.command([PRIVATE], {})
            self.assertEqual(str(caught.exception), category)
        self.assertEqual(str(p.CheckFailure(PRIVATE)), "unknown_error")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            p.Report().check("unknown_exception", lambda: (_ for _ in ()).throw(RuntimeError(PRIVATE)))
        self.assertEqual(json.loads(out.getvalue())["failure"], "unknown_error")
        self.assertNotIn(PRIVATE, out.getvalue())

    def test_real_failing_process_stdout_stderr_and_args_never_reach_report(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = os.path.join(directory, "fake-cli.py")
            with open(fake, "w") as file:
                file.write("import sys\nprint(sys.argv[1])\nsys.stderr.write('Error from server (Forbidden): '+sys.argv[1])\nsys.exit(1)\n")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                report = p.Report()
                report.check("api_read", lambda: p.command([sys.executable, fake, PRIVATE], dict(os.environ)))
            self.assertEqual(json.loads(output.getvalue()), {"check": "api_read", "ok": False, "failure": "forbidden"})
            self.assertNotIn(directory, output.getvalue())

    def test_read_scope_stays_namespace_only_and_legacy_probe_is_exact_name(self):
        data = fixtures()
        seen = []
        def read(args, env):
            seen.append(args)
            # Returning an empty object is enough to inspect scope; all semantic
            # failures are captured/redacted and no required check can pass.
            return "{}"
        with patch.object(p, "command", side_effect=read), contextlib.redirect_stdout(io.StringIO()):
            report = p.Report()
            p.check_cluster(report, {})
        self.assertEqual(len(seen), 9)
        self.assertTrue(all(args[:5] == ["kubectl", "--namespace", p.NAMESPACE, "--request-timeout=30s", "get"] for args in seen))
        self.assertEqual(seen[-1][5:], ["endpoints", p.RELAY, "-o", "json"])
        self.assertFalse(any("auth" in args or "secrets" in args for args in seen))
        self.assertFalse(report.ok)


class Response:
    status = 200

    def __init__(self, body, headers=None):
        self.body = body
        self.headers = Message()
        for k, v in (headers or {"Content-Type": "application/json", "Cache-Control": "no-store"}).items():
            self.headers[k] = v

    def read(self, limit):
        return self.body[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class Opener:
    def __init__(self):
        self.requests = []
        self.responses = [
            Response(json.dumps({"version": RELEASE, "commit": SHA}).encode()),
            Response(b"ok", {"Cache-Control": "no-store", "X-AAH-Version": RELEASE, "X-AAH-Commit": SHA}),
            Response(b'{"trusted_proxy":true,"valid_suffix":true}'),
            Response(b'{"trusted_proxy":true,"valid_suffix":true}'),
        ]

    def open(self, request, timeout):
        self.requests.append(request)
        return self.responses.pop(0)


class PublicTests(unittest.TestCase):
    def run_probe(self, opener):
        report = p.Report()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            public.verify(report, RELEASE, SHA, opener)
        self.assertNotIn(PRIVATE, out.getvalue())
        return report.ok

    def test_expected_public_release_and_spoof_prefix(self):
        opener = Opener()
        self.assertTrue(self.run_probe(opener))
        self.assertEqual([r.full_url for r in opener.requests], [public.ORIGIN + path for path in
                         ("/version.json", "/healthz", "/healthz/proxy", "/healthz/proxy")])
        self.assertEqual(opener.requests[-1].get_header("X-forwarded-for"), "198.51.100.123, malformed-client-prefix")
        self.assertFalse(any(r.has_header("Authorization") for r in opener.requests))

    def test_public_failures_and_privacy_violations_fail_closed(self):
        for body in [b'{"trusted_proxy":false,"valid_suffix":true}', b'{"trusted_proxy":1,"valid_suffix":1}',
                     b'{"trusted_proxy":true,"valid_suffix":true,"ip":"private"}', b"<html>private</html>", b"x" * 16385]:
            opener = Opener()
            opener.responses[2] = Response(body)
            self.assertFalse(self.run_probe(opener))
        for headers in [{"Cache-Control": "max-age=60"}, {"Cache-Control": "no-store", "Content-Type": "text/html"}]:
            opener = Opener()
            opener.responses[0] = Response(json.dumps({"version": RELEASE, "commit": SHA}).encode(), headers)
            self.assertFalse(self.run_probe(opener))
        opener = Opener()
        opener.responses[1] = Response(b"ok", {"Cache-Control": "no-store", "X-AAH-Version": "old", "X-AAH-Commit": SHA})
        self.assertFalse(self.run_probe(opener))

    def test_no_redirects_or_proxy_environment(self):
        self.assertIsNone(public.NoRedirect().redirect_request(None, None, 302, "", {}, "http://private.example"))
        with patch.dict(os.environ, {"EXPECTED_VERSION": RELEASE, "EXPECTED_COMMIT": SHA,
                                   "https_proxy": "http://private.example", "HTTPS_PROXY": "http://private.example"}), \
                patch.object(public, "verify") as verify, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(public.main(), 0)
            opener = verify.call_args.args[-1]
            self.assertFalse(any(isinstance(h, public.ProxyHandler) and h.proxies for h in opener.handlers))
            self.assertEqual([type(h) for h in opener.handlers if isinstance(h, public.HTTPRedirectHandler)], [public.NoRedirect])


if __name__ == "__main__":
    unittest.main()
