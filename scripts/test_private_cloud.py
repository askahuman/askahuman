"""Synthetic process and pinned-bundle tests; never authenticate to a cloud."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import private_cloud as cloud
from production_preflight import CheckFailure, Report

MARKER = "synthetic-private-identity-do-not-log"


class PrivacyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.workspace = self.directory / "workspace"
        self.workspace.mkdir()
        self.env = {"PATH": os.environ.get("PATH", ""), "GITHUB_ACTIONS": "true",
                    "RUNNER_TEMP": str(self.directory), "GITHUB_WORKSPACE": str(self.workspace),
                    "GCP_PROJECT": MARKER, "GCP_WIF_PROVIDER": MARKER, "GCP_DEPLOYER_SA": MARKER,
                    "GKE_CLUSTER": MARKER, "GAR_REGISTRY": "registry.example.invalid/project/private-repository",
                    "TAG": "v1.2.3", "GITHUB_SHA": "a" * 40}
        for field in ("GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_STATE", "GITHUB_PATH"):
            file = self.directory / field.lower()
            file.touch()
            self.env[field] = str(file)

    def script(self, source):
        path = self.directory / ("child-" + str(len(list(self.directory.glob("child-*")))) + ".py")
        path.write_text(source)
        return [sys.executable, str(path)]

    def report(self, predicate):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            report = Report()
            report.check("synthetic_step", predicate)
        return report, output.getvalue()

    def test_success_and_raw_failures_never_reach_public_report(self):
        for status in (0, 1):
            args = self.script("import sys\nprint(" + repr(MARKER) + ")\n"
                               "sys.stderr.write('::error::'+" + repr(MARKER) + ")\nsys.exit(" + str(status) + ")\n")
            report, output = self.report(lambda: cloud.captured(args, self.env) is not None)
            self.assertEqual(report.ok, status == 0)
            self.assertNotIn(MARKER, output)
            self.assertNotIn(str(self.directory), output)
            self.assertNotIn("::error::", output)
            self.assertEqual(json.loads(output)["check"], "synthetic_step")

    def test_only_action_mask_registrations_cross_output_and_file_commands_survive(self):
        args = self.script("import os,sys\n"
                           "for name in ('GITHUB_ENV','GITHUB_OUTPUT','GITHUB_STATE','GITHUB_PATH'):\n"
                           " with open(os.environ[name],'a') as f:f.write('retained-file-command\\n')\n"
                           "sys.stdout.write('::add-');sys.stdout.flush()\n"
                           "sys.stdout.write('mask::synthetic-token%0Acontinued\\n')\n"
                           "print('::error::'+" + repr(MARKER) + ")\n"
                           "print('::set-output name=leak::'+" + repr(MARKER) + ")\n"
                           "sys.stderr.write('::add-mask::stderr-must-not-be-forwarded\\n')\n")
        report, output = self.report(lambda: cloud.captured(args, self.env, action_masks=True) is not None)
        self.assertTrue(report.ok)
        lines = output.splitlines()
        self.assertEqual(lines[0], "::add-mask::synthetic-token%0Acontinued")
        self.assertEqual(json.loads(lines[1]), {"check": "synthetic_step", "ok": True})
        self.assertEqual(len(lines), 2)
        self.assertNotIn(MARKER, output)
        for name in ("GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_STATE", "GITHUB_PATH"):
            self.assertEqual(Path(self.env[name]).read_text(), "retained-file-command\n")
        _, output = self.report(lambda: cloud.captured(args, self.env) is not None)
        self.assertNotIn("add-mask", output, "Ordinary CLI output cannot emit workflow commands")

    def test_large_outputs_are_drained_with_bounded_capture_and_late_masks_work(self):
        args = self.script("import sys\n"
                           "sys.stdout.write('x'*2000000+'\\n');sys.stderr.write('y'*2000000)\n"
                           "print('::add-mask::late-synthetic-token')\n")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            captured = cloud.captured(args, self.env, action_masks=True)
        self.assertEqual(len(captured), cloud.CAPTURE_LIMIT)
        self.assertEqual(output.getvalue(), "::add-mask::late-synthetic-token\n")

    def test_mask_limits_fail_closed(self):
        for source in ("print('::add-mask::')", "print('::add-mask::token\\n'*33,end='')",
                       "print('::add-mask::'+'x'*65536)", "print('::add-mask::unfinished',end='')"):
            args = self.script(source)
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(CheckFailure):
                cloud.captured(args, self.env, action_masks=True)

    def test_mask_controls_cannot_inject_a_second_runner_command(self):
        for control in (b"\r", b"\x00", b"\x0b", b"\x7f", b"\xc2\x85", b"\xe2\x80\xa8", b"\xff"):
            with self.subTest(control=control):
                payload = b"::add-mask::synthetic-token" + control + b"::error::" + MARKER.encode() + b"\n"
                args = self.script("import sys\nsys.stdout.buffer.write(" + repr(payload) + ")\n")
                report, output = self.report(lambda: cloud.captured(args, self.env, action_masks=True) is not None)
                self.assertFalse(report.ok)
                self.assertEqual(json.loads(output)["failure"], "invalid_data")
                self.assertNotIn(MARKER, output)
                self.assertNotIn("::", output)
        # A CRLF terminates only the mask line; a following raw annotation is
        # consumed and never replayed. Escaped %, CR, and LF remain unchanged.
        args = self.script("import sys,time\n"
                           "for part in (b'::add-',b'mask::token%25%0D%0A',b'\\r',b'\\n::error::'+" + repr(MARKER.encode()) + "+b'\\r\\n'):\n"
                           " sys.stdout.buffer.write(part);sys.stdout.flush();time.sleep(.01)\n")
        report, output = self.report(lambda: cloud.captured(args, self.env, action_masks=True) is not None)
        self.assertTrue(report.ok)
        self.assertEqual(output.splitlines(), ["::add-mask::token%25%0D%0A", '{"check": "synthetic_step", "ok": true}'])

    def test_environment_export_keeps_following_preflight_and_registry_state_private(self):
        with patch.object(cloud, "BUNDLES", {}):
            self.assertTrue(cloud.prepare(self.env))
        exported = dict(line.split("=", 1) for line in Path(self.env["GITHUB_ENV"]).read_text().splitlines())
        self.assertEqual(exported, cloud.isolated_configuration(self.env))
        later = dict(self.env, **exported)
        for field, name in (("CLOUDSDK_CONFIG", "gcloud"), ("DOCKER_CONFIG", "docker"), ("KUBECONFIG", "kubeconfig")):
            self.assertEqual(later[field], str(self.directory / "aah-cloud-workflow" / name))
            self.assertEqual(cloud.child_environment(later)[field], later[field])
        for name in ("", "gcloud", "docker"):
            self.assertEqual((self.directory / "aah-cloud-workflow" / name).stat().st_mode & 0o777, 0o700)
        (Path(later["CLOUDSDK_CONFIG"]) / "synthetic-token").write_text(MARKER)
        (Path(later["DOCKER_CONFIG"]) / "config.json").write_text(MARKER)
        Path(later["KUBECONFIG"]).write_text(MARKER)
        self.assertTrue(cloud.cleanup(later))
        self.assertFalse((self.directory / "aah-cloud-workflow").exists())

    def test_timeout_kills_stubborn_process_without_error_text(self):
        pidfile = self.directory / "pid"
        args = self.script("import os,signal,time\n"
                           "signal.signal(signal.SIGTERM,lambda *args:None)\n"
                           "open(" + repr(str(pidfile)) + ",'w').write(str(os.getpid()))\n"
                           "print(" + repr(MARKER) + ",flush=True)\nwhile True:time.sleep(1)\n")
        report, output = self.report(lambda: cloud.captured(args, self.env, timeout=0.3))
        self.assertFalse(report.ok)
        self.assertEqual(json.loads(output)["failure"], "timeout")
        self.assertNotIn(MARKER, output)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pidfile.read_text()), 0)

    def test_unavailable_command_and_unknown_stage_are_fixed_failures(self):
        report, output = self.report(lambda: cloud.captured([str(self.directory / MARKER)], self.env))
        self.assertFalse(report.ok)
        self.assertEqual(json.loads(output)["failure"], "tool_unavailable")
        self.assertNotIn(MARKER, output)
        with patch.object(sys, "argv", ["private_cloud.py", MARKER]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cloud.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {"check": "cloud_workflow_inputs", "ok": False})

    def test_download_pins_and_integrity_reject_before_execution(self):
        data = b"synthetic action bundle"
        expected = hashlib.sha256(data).hexdigest()
        urls = []
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return data
        class Opener:
            def open(self, url, timeout):
                urls.append(url)
                return Response()
        with patch.dict(cloud.BUNDLES, {"synthetic.js": ("auth", cloud.AUTH_REF, "dist/main/index.js", expected)}, clear=True), \
                patch.object(cloud, "build_opener", return_value=Opener()):
            self.assertTrue(cloud.prepare(self.env))
            self.assertEqual(urls, [f"https://raw.githubusercontent.com/google-github-actions/auth/{cloud.AUTH_REF}/dist/main/index.js"])
            path = cloud.bundle_path(self.env, "synthetic.js")
            self.assertEqual(path.read_bytes(), data)
            path.write_bytes(b"changed response")
            with self.assertRaises(CheckFailure): cloud.bundle_path(self.env, "synthetic.js")
        self.assertIsNone(cloud.NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.invalid"))

    def test_public_setup_has_no_credential_context_and_action_inputs_are_explicit(self):
        env = dict(self.env, GOOGLE_GHA_CREDS_PATH=MARKER, GOOGLE_APPLICATION_CREDENTIALS=MARKER,
                   CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=MARKER, INPUT_CREDENTIALS_JSON=MARKER)
        calls = []
        def capture(args, child, **kwargs):
            calls.append((args, child, kwargs))
            return "v24.1.0\n" if args == ["node", "--version"] else ""
        with patch.object(cloud, "bundle_path", return_value=Path("/synthetic-bundle.js")), patch.object(cloud, "captured", side_effect=capture):
            self.assertTrue(cloud.execute("install_sdk", env))
            public = calls[-1][1]
            for key in ("GOOGLE_GHA_CREDS_PATH", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", "GCP_PROJECT", "GCP_WIF_PROVIDER", "GCP_DEPLOYER_SA", "GAR_REGISTRY", "INPUT_CREDENTIALS_JSON"):
                self.assertNotIn(key, public)
            self.assertEqual(public["INPUT_INSTALL_COMPONENTS"], "gke-gcloud-auth-plugin")
            self.assertTrue(public["CLOUDSDK_CONFIG"].startswith(str(self.directory)))
            cloud.execute("authenticate", env)
            authenticated = calls[-1][1]
            self.assertEqual(authenticated["INPUT_WORKLOAD_IDENTITY_PROVIDER"], MARKER)
            self.assertEqual(authenticated["INPUT_SERVICE_ACCOUNT"], MARKER)
            self.assertEqual(authenticated["INPUT_CREDENTIALS_JSON"], "")
            self.assertEqual(authenticated["INPUT_TOKEN_FORMAT"], "")
            self.assertEqual(authenticated["GITHUB_ENV"], env["GITHUB_ENV"])
            self.assertTrue(calls[-1][2]["action_masks"])

    def test_private_commands_retain_build_identity_namespace_and_rollout_gates(self):
        calls = []
        def capture(args, child, **kwargs):
            calls.append((args, child, kwargs))
            return "/synthetic/go\n" if args == ["go", "env", "GOPATH"] else ""
        with patch.object(cloud, "captured", side_effect=capture):
            for stage in ("configure_registry", "build_relay", "build_web", "cluster_credentials", "rollout"):
                self.assertTrue(cloud.execute(stage, self.env))
        self.assertEqual(calls[0][0], ["gcloud", "auth", "configure-docker", "registry.example.invalid", "--quiet"])
        relay = next(call for call in calls if call[0][0].endswith("/bin/ko"))
        self.assertEqual(relay[0][1:], ["build", "--bare", "--platform=linux/amd64", "--tags", "1.2.3,latest", "./cmd/relay"])
        self.assertEqual(relay[1]["KO_DOCKER_REPO"], self.env["GAR_REGISTRY"] + "/relay")
        self.assertEqual(relay[1]["AAH_BUILD_COMMIT"], "a" * 40)
        web = next(call for call in calls if call[0][:2] == ["docker", "buildx"])
        self.assertIn("PUBLIC_BUILD_VERSION=1.2.3", web[0])
        self.assertIn("PUBLIC_BUILD_COMMIT=" + "a" * 40, web[0])
        credential = next(call for call in calls if "get-credentials" in call[0])
        self.assertEqual(credential[0], ["gcloud", "container", "fleet", "memberships", "get-credentials", MARKER, "--project", MARKER, "--quiet"])
        self.assertTrue(credential[1]["KUBECONFIG"].startswith(str(self.directory)))
        rollouts = [call[0] for call in calls if call[0][0] == "kubectl"]
        self.assertEqual(rollouts, [["kubectl", "rollout", "status", "deploy/ask-a-human-" + name, "-n", "ask-a-human", "--timeout=180s"] for name in ("relay", "web")])

    def test_apply_uses_private_copy_and_cleanup_is_bounded_to_owned_files(self):
        source = self.directory / "source"
        for name in ("base", "prod"):
            folder = source / "infra" / name
            folder.mkdir(parents=True)
            (folder / "kustomization.yaml").write_text("public-placeholder")
        calls = []
        def capture(args, child, **kwargs):
            calls.append((args, kwargs))
            if args[0] == "kustomize":
                (kwargs["cwd"] / "kustomization.yaml").write_text(MARKER)
            return ""
        with patch.object(cloud, "ROOT", source), patch.object(cloud, "captured", side_effect=capture):
            self.assertTrue(cloud.execute("apply", self.env))
        self.assertEqual((source / "infra/prod/kustomization.yaml").read_text(), "public-placeholder")
        self.assertEqual(calls[-1][0], ["kubectl", "apply", "-k", ".", "-o", "name"])
        self.assertTrue(str(calls[-1][1]["cwd"]).startswith(str(cloud.private_directory(self.env))))
        credential = self.workspace / "gha-creds-0123456789abcdef.json"
        credential.write_text(MARKER)
        with patch.object(cloud, "action", side_effect=CheckFailure("tool_error")):
            self.assertFalse(cloud.cleanup(dict(self.env, GOOGLE_GHA_CREDS_PATH=str(credential))))
        self.assertFalse(credential.exists())
        self.assertFalse((self.directory / "aah-cloud-workflow").exists())
        foreign = self.directory / "unrelated.json"
        foreign.write_text(MARKER)
        with patch.object(cloud, "action") as post:
            self.assertFalse(cloud.cleanup(dict(self.env, GOOGLE_GHA_CREDS_PATH=str(foreign))))
            post.assert_not_called()
        self.assertTrue(foreign.exists())
        for candidate in (self.workspace / "gha-creds-deadbeef.json", self.workspace / "gha-creds-feedface.json"):
            if candidate.name.endswith("deadbeef.json"):
                candidate.symlink_to(foreign)
            else:
                candidate.mkdir()
            with patch.object(cloud, "action") as post:
                self.assertFalse(cloud.cleanup(dict(self.env, GOOGLE_GHA_CREDS_PATH=str(candidate))))
                post.assert_not_called()
            self.assertTrue(candidate.exists())
            self.assertTrue(foreign.exists())

    def test_invalid_release_inputs_cannot_start_a_command(self):
        for mutation in ({"TAG": MARKER}, {"GITHUB_SHA": MARKER}, {"GAR_REGISTRY": "https://" + MARKER}):
            with patch.object(cloud, "captured") as run:
                with self.assertRaises(CheckFailure): cloud.execute("build_web", dict(self.env, **mutation))
                run.assert_not_called()


class PinnedBundleTests(unittest.TestCase):
    setUp = PrivacyTests.setUp
    report = PrivacyTests.report

    def prepare_bundles(self):
        directory = os.environ.get("AAH_ACTION_BUNDLE_DIR")
        if not directory:
            self.skipTest("Set AAH_ACTION_BUNDLE_DIR to verified public bundles for the runtime smoke test")
        prepared = cloud.private_directory(self.env)
        for name in cloud.BUNDLES:
            shutil.copyfile(Path(directory) / name, prepared / name)
            cloud.bundle_path(self.env, name)
        return prepared

    def test_actual_pinned_node_entry_points_and_file_commands_without_cloud_access(self):
        self.prepare_bundles()
        # Missing GitHub OIDC variables make the actual WIF action fail before
        # any cloud request; its raw annotation must stay behind capture.
        report, output = self.report(lambda: cloud.execute("authenticate", self.env))
        self.assertFalse(report.ok)
        self.assertNotIn(MARKER, output)
        self.assertNotIn("::error::", output)
        self.assertFalse(any(self.workspace.glob("gha-creds-*")))
        # Run the real setup bundle against a synthetic gcloud executable.
        # skip_install avoids all SDK/tool downloads and cloud calls.
        binaries = self.directory / "bin"
        binaries.mkdir()
        fake = binaries / "gcloud"
        fake.write_text("#!/bin/sh\nprintf '%s\\n' 'synthetic-private-identity-do-not-log' >&2\nexit 1\n")
        fake.chmod(0o755)
        env = dict(self.env, PATH=str(binaries) + os.pathsep + self.env["PATH"])
        report, output = self.report(lambda: cloud.action(env, "setup-gcloud.js", {"skip_install": "true", "version": "", "install_components": ""}))
        self.assertTrue(report.ok, "The unauthenticated public setup path should finish without a cloud call")
        self.assertNotIn(MARKER, output)
        self.assertIn("CLOUDSDK_METRICS_ENVIRONMENT", Path(env["GITHUB_ENV"]).read_text())
        self.assertIn("version", Path(env["GITHUB_OUTPUT"]).read_text())
        # The authentication path must fail closed on a real action error.
        env["GOOGLE_GHA_CREDS_PATH"] = str(self.workspace / "gha-creds-abcdef.json")
        report, output = self.report(lambda: cloud.action(env, "setup-gcloud.js", {"skip_install": "true", "version": "", "install_components": ""}))
        self.assertFalse(report.ok)
        self.assertNotIn(MARKER, output)
        credential = Path(env["GOOGLE_GHA_CREDS_PATH"])
        credential.write_text("synthetic-not-a-credential")
        self.assertTrue(cloud.cleanup(env))
        self.assertFalse(credential.exists())

    def test_actual_auth_success_masks_environment_and_cleanup_with_all_sockets_disabled(self):
        prepared = self.prepare_bundles()
        preload = self.directory / "synthetic-network.cjs"
        # The real pinned auth bundle uses its actual request/response logic,
        # but every HTTP request stays in-process and any socket open fails.
        preload.write_text(r'''
const {EventEmitter} = require('node:events');
const {Readable} = require('node:stream');
const fs = require('node:fs');
require('node:net').Socket.prototype.connect = function() { throw new Error('unexpected network'); };
function syntheticRequest(options, callback) {
  const host = options.hostname || options.host;
  let payload;
  if (host === 'oidc.example.invalid') payload = {value:'synthetic.oidc.token'};
  else if (host === 'sts.googleapis.com') payload = {access_token:'synthetic-exchanged-token', expires_in:3600, token_type:'Bearer'};
  else throw new Error('unexpected host');
  fs.appendFileSync(process.env.SYNTHETIC_REQUESTS, host+'\n');
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.write = () => true;
  request.destroy = () => request;
  request.abort = () => request;
  request.end = () => { setImmediate(() => {
    const response = Readable.from([Buffer.from(JSON.stringify(payload))]);
    response.statusCode = 200;
    response.headers = {'content-type':'application/json'};
    callback(response);
  }); };
  return request;
}
require('node:http').request = syntheticRequest;
require('node:https').request = syntheticRequest;
''')
        requests = self.directory / "requests"
        env = dict(self.env, GCP_PROJECT="synthetic-project",
                   GCP_WIF_PROVIDER="projects/123456789000/locations/global/workloadIdentityPools/synthetic-pool/providers/synthetic-provider",
                   GCP_DEPLOYER_SA="synthetic-deployer@synthetic-project.iam.gserviceaccount.com",
                   ACTIONS_ID_TOKEN_REQUEST_URL="https://oidc.example.invalid/token?test=1",
                   ACTIONS_ID_TOKEN_REQUEST_TOKEN="synthetic-request-token",
                   NODE_OPTIONS="--require=" + str(preload), SYNTHETIC_REQUESTS=str(requests))
        report, output = self.report(lambda: cloud.execute("authenticate", env))
        self.assertTrue(report.ok)
        self.assertEqual(output.splitlines(), ["::add-mask::synthetic.oidc.token", "::add-mask::synthetic-exchanged-token",
                                             '{"check": "synthetic_step", "ok": true}'])
        self.assertEqual(requests.read_text().splitlines(), ["oidc.example.invalid", "sts.googleapis.com"])
        lines = iter(Path(env["GITHUB_ENV"]).read_text().splitlines())
        for line in lines:
            key, delimiter = line.split("<<", 1)
            value = []
            for part in lines:
                if part == delimiter:
                    break
                value.append(part)
            env[key] = "\n".join(value)
        credential = Path(env["GOOGLE_GHA_CREDS_PATH"])
        self.assertEqual(credential.parent, self.workspace)
        data = json.loads(credential.read_text())
        self.assertEqual(data["type"], "external_account")
        self.assertEqual(data["credential_source"]["headers"]["Authorization"], "Bearer synthetic-request-token")
        self.assertEqual(env["CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"], str(credential))
        self.assertEqual(env["GOOGLE_APPLICATION_CREDENTIALS"], str(credential))
        self.assertEqual(env["CLOUDSDK_CORE_PROJECT"], "synthetic-project")
        report, output = self.report(lambda: cloud.cleanup(env))
        self.assertTrue(report.ok)
        self.assertEqual(output.splitlines(), ['{"check": "synthetic_step", "ok": true}'])
        self.assertFalse(credential.exists())
        self.assertFalse(prepared.exists())


if __name__ == "__main__":
    unittest.main()
