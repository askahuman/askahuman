import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import npm_recovery as recovery


TAG = "v0.2.0"
COMMIT = "a" * 40
TAG_OBJECT = "b" * 40
ROOT = Path(__file__).resolve().parent.parent


def api_fixture():
    release = {"id": 1, "tag_name": TAG, "draft": False, "prerelease": False,
               "published_at": "2026-01-01T00:00:00Z", "assets": [
                   {"name": name, "size": 10, "state": "uploaded", "browser_download_url":
                    f"https://github.com/{recovery.REPOSITORY}/releases/download/{TAG}/{name}"}
                   for name in sorted(recovery.ASSETS)]}
    return {"releases/tags/" + TAG: release,
            "git/ref/tags/" + TAG: {"ref": "refs/tags/" + TAG,
                                   "object": {"type": "commit", "sha": COMMIT}}}


def reader(values):
    def read(url, token=None, **kwargs):
        prefix = f"https://api.github.com/repos/{recovery.REPOSITORY}/"
        if not url.startswith(prefix):
            raise AssertionError("unexpected API host")
        return copy.deepcopy(values[url.removeprefix(prefix)])
    return read


class RecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT,
                                    capture_output=True, text=True, check=True).stdout.strip()

    def test_stable_tags_reject_shell_and_semver_ambiguities(self):
        for tag in ("v0.0.0", "v1.2.3", "v9007199254740991.0.0"):
            self.assertEqual(len(recovery.version_tuple(tag)), 3)
        for tag in (None, [], 1, "", "0.2.0", "v01.2.3", "v1.2", "v1.2.3\n",
                    "v1.2.3\r", "v1.2.3-rc.1", "v1.2.3+build", "v1.2.3/other",
                    "v1.2.3;printf injected", "$(echo injected)", "v１.2.3",
                    "v9007199254740992.0.0", "v" + "9" * 200 + ".0.0"):
            with self.subTest(tag=tag), self.assertRaises(recovery.CheckFailure):
                recovery.version_tuple(tag)

    def test_lightweight_and_annotated_tags_resolve_exact_commit(self):
        values = api_fixture()
        self.assertEqual(recovery.resolve_release(TAG, read=reader(values)),
                         {"commit": COMMIT, "release_id": 1})
        values["git/ref/tags/" + TAG]["object"] = {"type": "tag", "sha": TAG_OBJECT}
        values["git/tags/" + TAG_OBJECT] = {"sha": TAG_OBJECT,
                                          "object": {"type": "commit", "sha": COMMIT}}
        self.assertEqual(recovery.resolve_release(TAG, read=reader(values))["commit"], COMMIT)

    def test_release_and_asset_failures_close_before_checkout(self):
        cases = [lambda v: v["releases/tags/" + TAG].update(draft=True),
                 lambda v: v["releases/tags/" + TAG].update(prerelease=True),
                 lambda v: v["releases/tags/" + TAG].update(draft=0),
                 lambda v: v["releases/tags/" + TAG].update(published_at=None),
                 lambda v: v["releases/tags/" + TAG].update(id=True),
                 lambda v: v["releases/tags/" + TAG].update(tag_name="v0.2.1"),
                 lambda v: v["releases/tags/" + TAG]["assets"].pop(),
                 lambda v: v["releases/tags/" + TAG]["assets"].append(
                     v["releases/tags/" + TAG]["assets"][0]),
                 lambda v: v["releases/tags/" + TAG]["assets"][0].update(size=0),
                 lambda v: v["releases/tags/" + TAG]["assets"][0].update(state="new"),
                 lambda v: v["releases/tags/" + TAG]["assets"][0].update(
                     browser_download_url="https://example.invalid/asset"),
                 lambda v: v["git/ref/tags/" + TAG].update(ref="refs/heads/main"),
                 lambda v: v["git/ref/tags/" + TAG]["object"].update(type="tree"),
                 lambda v: v["git/ref/tags/" + TAG]["object"].update(sha="a" * 39)]
        for index, mutate in enumerate(cases):
            with self.subTest(index=index):
                values = api_fixture()
                mutate(values)
                with self.assertRaises(recovery.CheckFailure):
                    recovery.resolve_release(TAG, read=reader(values))
        values = api_fixture()
        values["git/ref/tags/" + TAG]["object"] = {"type": "tag", "sha": TAG_OBJECT}
        values["git/tags/" + TAG_OBJECT] = {"sha": TAG_OBJECT,
                                          "object": {"type": "tag", "sha": TAG_OBJECT}}
        with self.assertRaises(recovery.CheckFailure):
            recovery.resolve_release(TAG, read=reader(values))

    def test_registry_refuses_existing_versions_and_latest_rollback(self):
        def check(value):
            return recovery.registry_state(TAG, read=lambda *args, **kwargs: value)
        self.assertTrue(check(None))
        self.assertTrue(check({"name": recovery.PACKAGE, "versions": {"0.1.16": {}},
                               "dist-tags": {"latest": "0.1.16"}}))
        for value in ({}, [], {"name": recovery.PACKAGE, "versions": {"0.2.0": {}},
                              "dist-tags": {"latest": "0.1.16"}},
                      {"name": recovery.PACKAGE, "versions": {}, "dist-tags": {"latest": "0.3.0"}},
                      {"name": recovery.PACKAGE, "versions": {}, "dist-tags": {"latest": "0.2.0-rc.1"}},
                      {"name": "@other/package", "versions": {}, "dist-tags": {"latest": "0.1.16"}}):
            with self.subTest(value=value), self.assertRaises(recovery.CheckFailure):
                check(value)

    def test_api_redirect_errors_duplicates_and_credentials_are_private(self):
        for raw in ('{"draft":false,"draft":true}', '{"value":NaN}'):
            with self.assertRaises(recovery.CheckFailure):
                recovery.strict_json(raw)
        for code, category in ((302, "api_error"), (401, "unauthenticated"),
                               (403, "forbidden"), (404, "not_found"), (429, "rate_limited")):
            class Opener:
                def open(self, request, timeout):
                    raise HTTPError(request.full_url, code, "private-synthetic-message", {}, None)
            with patch.object(recovery, "build_opener", return_value=Opener()):
                with self.assertRaises(recovery.CheckFailure) as caught:
                    recovery.read_json("https://api.github.com/repos/askahuman/askahuman/releases")
                self.assertEqual(str(caught.exception), category)
        with self.assertRaises(recovery.CheckFailure):
            recovery.read_json(recovery.REGISTRY + "/package", "synthetic-token")

    def test_actual_npm_pack_has_only_exact_tracked_payload_without_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            poisoned = dict(os.environ, NODE_AUTH_TOKEN="synthetic-token", GH_TOKEN="synthetic-github",
                            NPM_CONFIG_REGISTRY="https://example.invalid", NODE_OPTIONS="--invalid-option")
            archive, common, config, integrity = recovery.prepare_package(
                ROOT, self.commit, TAG, directory, poisoned)
            self.assertTrue(archive.is_file())
            self.assertIn("--ignore-scripts", common)
            self.assertIn("--registry=https://registry.npmjs.org", common)
            self.assertNotIn("synthetic-token", config.read_text())
            with tarfile.open(archive) as tar:
                self.assertEqual(set(tar.getnames()), {"package/" + name for name in recovery.FILES})
                manifest = json.load(tar.extractfile("package/package.json"))
                self.assertEqual(manifest["version"], TAG[1:])
                for name in ("install.js", "bin/cli.js"):
                    expected = subprocess.run(["git", "show", f"{self.commit}:npm/{name}"], cwd=ROOT,
                                              capture_output=True, check=True).stdout
                    self.assertEqual(tar.extractfile("package/" + name).read(), expected)
            self.assertTrue(integrity.startswith("sha512-"))
            child = recovery.clean_environment(poisoned)
            for key in ("NODE_AUTH_TOKEN", "GH_TOKEN", "NPM_CONFIG_REGISTRY", "NODE_OPTIONS", "HOME"):
                self.assertNotIn(key, child)

    def test_manifest_scripts_destinations_and_wrong_checkout_rejected(self):
        original = recovery.captured
        mutations = [lambda v: v.update(name="@other/package"),
                     lambda v: v["scripts"].update(prepublishOnly="echo unsafe"),
                     lambda v: v.update(publishConfig={"registry": "https://example.invalid"}),
                     lambda v: v.update(files=["**"]),
                     lambda v: v.update(dependencies={"other": "*"})]
        for index, mutate in enumerate(mutations):
            def run(args, env, **kwargs):
                raw = original(args, env, **kwargs)
                if args[1] == "show" and args[-1].endswith(":npm/package.json"):
                    value = json.loads(raw)
                    mutate(value)
                    return json.dumps(value)
                return raw
            with self.subTest(index=index), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaises(recovery.CheckFailure):
                    recovery.prepare_package(ROOT, self.commit, TAG, Path(temporary), os.environ, run=run)
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(recovery.CheckFailure):
            recovery.prepare_package(ROOT, "0" * 40, TAG, Path(temporary), os.environ)

    def test_tar_payload_modification_extra_members_symlink_and_filename_rejected(self):
        original = recovery.captured
        for mutation in ("changed_script", "extra_file", "symlink", "filename"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)

                def run(args, env, **kwargs):
                    raw = original(args, env, **kwargs)
                    if args[:2] != ["npm", "pack"]:
                        return raw
                    if mutation == "filename":
                        return '[{"filename":"../outside.tgz"}]'
                    archive = directory / "askahuman-mcp-0.2.0.tgz"
                    with tarfile.open(archive) as tar:
                        members = [(member, tar.extractfile(member).read()) for member in tar.getmembers()]
                    if mutation == "extra_file":
                        extra = tarfile.TarInfo("package/private-extra")
                        extra.size = 4
                        members.append((extra, b"test"))
                    with tarfile.open(archive, "w:gz") as tar:
                        for member, data in members:
                            if member.name == "package/install.js":
                                if mutation == "changed_script":
                                    data = b"modified"
                                    member.size = len(data)
                                if mutation == "symlink":
                                    member.type, member.linkname, member.size = tarfile.SYMTYPE, "outside", 0
                            tar.addfile(member, io.BytesIO(data))
                    return raw

                with self.assertRaises(recovery.CheckFailure):
                    recovery.prepare_package(ROOT, self.commit, TAG, directory, os.environ, run=run)

    def workflow_env(self):
        return dict(os.environ, GITHUB_ACTIONS="true", GITHUB_REPOSITORY=recovery.REPOSITORY,
                    GITHUB_REF="refs/heads/main", RELEASE_TAG=TAG, RELEASE_COMMIT=self.commit,
                    RELEASE_ID="1", RELEASE_SOURCE=str(ROOT), NODE_AUTH_TOKEN="synthetic-token",
                    GH_TOKEN="synthetic-github")

    def test_workflow_resolves_only_from_main_and_writes_validated_identity(self):
        resolved = {"commit": self.commit, "release_id": 1}
        with tempfile.TemporaryDirectory() as temporary:
            env = dict(self.workflow_env(), GITHUB_OUTPUT=str(Path(temporary) / "output"))
            with patch.object(sys, "argv", ["npm_recovery.py", "resolve"]), \
                    patch.object(recovery, "resolve_release", return_value=resolved), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(recovery.main(env), 0)
                self.assertEqual(Path(env["GITHUB_OUTPUT"]).read_text(),
                                 f"commit={self.commit}\nrelease_id=1\n")
        for key, value in (("GITHUB_REF", "refs/heads/other"), ("GITHUB_ACTIONS", "false"),
                           ("GITHUB_REPOSITORY", "other/repo"), ("RELEASE_TAG", "v0.2.0\n")):
            with self.subTest(key=key), patch.object(sys, "argv", ["npm_recovery.py", "resolve"]), \
                    patch.object(recovery, "resolve_release") as resolve, \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(recovery.main(dict(self.workflow_env(), **{key: value})), 1)
                resolve.assert_not_called()

    def test_publish_full_flow_uses_captured_fake_and_checks_exact_registry_integrity(self):
        self.run_publish_case("success")

    def test_publish_error_and_integrity_failure_clean_private_state(self):
        for result in ("publish_error", "wrong_integrity", "moved_tag", "changed_release", "registry_exists",
                       "missing_token", "malformed_token"):
            with self.subTest(result=result):
                self.run_publish_case(result)

    def run_publish_case(self, result):
        calls, private_directories = [], []
        resolved = {"commit": self.commit, "release_id": 1}
        outcomes = [resolved, dict(resolved)]
        if result == "moved_tag":
            outcomes[-1]["commit"] = "0" * 40
        if result == "changed_release":
            outcomes[-1]["release_id"] = 2
        expected_integrity = None
        original_prepare = recovery.prepare_package

        def prepare(*args, **kwargs):
            private_directories.append(args[3])
            return original_prepare(*args, **kwargs)

        def captured(args, env, **kwargs):
            nonlocal expected_integrity
            self.assertEqual(args[:2], ["npm", "publish"])
            calls.append(args)
            archive = Path(args[2])
            private_directories.append(archive.parent)
            self.assertNotIn("GH_TOKEN", env)
            self.assertEqual(env["NODE_AUTH_TOKEN"], "synthetic-token")
            self.assertIn("${NODE_AUTH_TOKEN}", (archive.parent / "npmrc").read_text())
            self.assertNotIn("synthetic-token", (archive.parent / "npmrc").read_text())
            self.assertIn("--ignore-scripts", args)
            self.assertIn("--tag=latest", args)
            self.assertIn("--access=public", args)
            self.assertEqual(kwargs["cwd"], archive.parent)
            if result == "publish_error":
                # Exercise the real bounded capture helper against a harmless
                # child that emits a synthetic npm E404 containing private data.
                return original_prepare.__kwdefaults__["run"](
                    [sys.executable, "-c", "import sys; print('private-synthetic-identity'); "
                     "print('npm error E404 synthetic-token', file=sys.stderr); sys.exit(1)"],
                    recovery.clean_environment(os.environ), cwd=archive.parent)
            expected_integrity = "sha512-" + recovery.base64.b64encode(
                hashlib.sha512(archive.read_bytes()).digest()).decode("ascii")
            return ""

        def read(url, token=None, **kwargs):
            self.assertIsNone(token)
            if url == recovery.REGISTRY + "/@askahuman%2fmcp":
                return {"name": recovery.PACKAGE, "versions": {TAG[1:]: {}} if result == "registry_exists" else {},
                        "dist-tags": {"latest": "0.1.16"}}
            self.assertEqual(url, recovery.REGISTRY + "/@askahuman%2fmcp/0.2.0")
            return {"name": recovery.PACKAGE, "version": "0.2.0",
                    "dist": {"integrity": "wrong" if result == "wrong_integrity" else expected_integrity}}

        output = io.StringIO()
        env = self.workflow_env()
        if result in {"missing_token", "malformed_token"}:
            env["NODE_AUTH_TOKEN"] = "" if result == "missing_token" else "invalid\ntoken"
        with patch.object(sys, "argv", ["npm_recovery.py", "publish"]), \
                patch.object(recovery, "resolve_release", side_effect=outcomes), \
                patch.object(recovery, "prepare_package", side_effect=prepare), \
                patch.object(recovery, "captured", side_effect=captured), \
                patch.object(recovery, "read_json", side_effect=read), contextlib.redirect_stdout(output):
            self.assertEqual(recovery.main(env), 0 if result == "success" else 1)
        self.assertEqual(len(calls), 0 if result in {"moved_tag", "changed_release", "registry_exists",
                                                   "missing_token", "malformed_token"} else 1)
        for directory in private_directories:
            self.assertFalse(directory.exists())
        public = output.getvalue()
        for private in ("synthetic-token", "synthetic-github", "private-synthetic-identity", "E404"):
            self.assertNotIn(private, public)
        for line in public.splitlines():
            record = json.loads(line)
            self.assertTrue(record["check"].startswith("npm_recovery_"))
            self.assertIsInstance(record["ok"], bool)
            self.assertLessEqual(set(record), {"check", "ok", "failure"})


if __name__ == "__main__":
    unittest.main()
