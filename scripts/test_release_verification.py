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
    result["relay_core_endpoints"] = {"metadata": {}, "subsets": [{"ports": [{"port": 8080, "protocol": "TCP"}],
        "addresses": [{"ip": "10.0.0.9", "targetRef": {"kind": "Pod", "uid": "relay-uid", "namespace": p.NAMESPACE}}]}]}
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

    def test_core_endpoints_only_diagnose_existing_permissions(self):
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
