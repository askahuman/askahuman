"""Deterministic topology, redaction and public-probe regressions; no live APIs."""
import contextlib
import copy
import io
import json
import os
import subprocess
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
            "metadata": {"uid": name + "-uid"},
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
    return result


class ClusterTests(unittest.TestCase):
    def run_cluster(self, data):
        output = io.StringIO()
        report = p.Report()
        with contextlib.redirect_stdout(output), patch.object(p, "read_object", side_effect=lambda _, key, *args: data[key]):
            p.check_cluster(report, {"GAR_REGISTRY": PRIVATE})
        self.assertNotIn(PRIVATE, output.getvalue())
        self.assertNotIn(NEG, output.getvalue())
        return report.ok, {x["check"]: x["ok"] for x in map(json.loads, output.getvalue().splitlines())}

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
            self.assertEqual(json.loads(out.getvalue()), {"check": "relay_pods_read", "ok": False})
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
