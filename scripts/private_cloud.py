#!/usr/bin/env python3
"""Fixed cloud workflow operations with no public command output.

Only GitHub's add-mask registrations from the pinned actions may cross stdout;
the runner consumes them as workflow commands, never as log messages. Action
environment/output/state/path files retain their normal GitHub semantics.
"""
import hashlib
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import threading
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener

from production_preflight import CheckFailure, COMMIT, Report, VERSION, command_failure

ROOT = Path(__file__).resolve().parent.parent
AUTH_REF = "7c6bc770dae815cd3e89ee6cdf493a5fab2cc093"  # gitleaks:allow public pinned Git commit
SETUP_REF = "aa5489c8933f4cc7a4f7d45035b3b1440c9c10db"
# Same immutable bundles previously invoked by uses:. Hashes also reject an
# unexpected response body before Node executes it. No npm install is needed.
BUNDLES = {
    "auth-main.js": ("auth", AUTH_REF, "dist/main/index.js", "9f4584c50974e46628292feacae77eaa4bf4b49bb529a154a9321fcefe0c226f"),
    "auth-post.js": ("auth", AUTH_REF, "dist/post/index.js", "6b49c062009deebaaec487cfafd706c1838c2b6bb549398ca34c218831752647"),
    "setup-gcloud.js": ("setup-gcloud", SETUP_REF, "dist/index.js", "cfe1bacc07e1b15e28ec8d8a9b26bd734d6a2087a939eda9d94bb7c004d0d5ae"),
}
STAGES = frozenset({"prepare", "install_sdk", "authenticate", "configure_sdk", "configure_registry",
                    "build_relay", "build_web", "cluster_credentials", "apply", "rollout", "cleanup"})
CAPTURE_LIMIT = 65536
MASK_LIMIT = 65536
MASK_PREFIX = b"::add-mask::"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def private_directory(env):
    if env.get("GITHUB_ACTIONS") != "true":
        raise CheckFailure("invalid_data")
    parent = Path(env.get("RUNNER_TEMP", ""))
    if not parent.is_absolute():
        raise CheckFailure("invalid_data")
    directory = parent / "aah-cloud-workflow"
    if directory.is_symlink():
        raise CheckFailure("invalid_data")
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    return directory


def isolated_configuration(env):
    directory = private_directory(env)
    for name in ("gcloud", "docker"):
        path = directory / name
        if path.is_symlink():
            raise CheckFailure("invalid_data")
        path.mkdir(mode=0o700, exist_ok=True)
        path.chmod(0o700)
    return {"CLOUDSDK_CONFIG": str(directory / "gcloud"),
            "KUBECONFIG": str(directory / "kubeconfig"),
            "DOCKER_CONFIG": str(directory / "docker"), "CLOUDSDK_CORE_DISABLE_PROMPTS": "1"}


def child_environment(env):
    result = dict(env, **isolated_configuration(env))
    # A run step has no action.yml input defaults. Supply only the reviewed
    # inputs explicitly instead of inheriting an unrelated action's inputs.
    return {key: value for key, value in result.items() if not key.startswith("INPUT_")}


def terminate_group(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=2)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            pass
    # Descendants may outlive their parent and keep the pipes open.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=5)


def captured(args, env, *, cwd=ROOT, timeout=300, action_masks=False):
    """Drain both pipes with bounded memory; never forward logs or annotations."""
    try:
        process = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    except FileNotFoundError:
        raise CheckFailure("tool_unavailable") from None
    except OSError:
        raise CheckFailure("tool_error") from None
    prefixes = [bytearray(), bytearray()]
    masks, invalid = [], threading.Event()

    def drain(pipe, index):
        line = b""
        oversized = False
        try:
            while chunk := pipe.read1(65536):
                prefixes[index].extend(chunk[:max(0, CAPTURE_LIMIT - len(prefixes[index]))])
                if not action_masks or index != 0:
                    continue
                # Split only at LF. Treat an interior CR/control as data to
                # reject, never as another runner command or a log boundary.
                parts = chunk.split(b"\n")
                for offset, part in enumerate(parts):
                    if not oversized:
                        line += part
                        if len(line) > MASK_LIMIT:
                            if line.startswith(MASK_PREFIX):
                                invalid.set()
                            line, oversized = b"", True
                    if offset < len(parts) - 1:
                        if not oversized and line.startswith(MASK_PREFIX):
                            value = line.removesuffix(b"\r")  # ordinary CRLF is valid
                            if len(masks) >= 32 or not value[len(MASK_PREFIX):]:
                                invalid.set()
                            else:
                                try:
                                    decoded = value.decode("utf-8", errors="strict")
                                    if any(ord(char) < 32 or 127 <= ord(char) <= 159 or char in "\u2028\u2029"
                                           for char in decoded):
                                        invalid.set()
                                    else:
                                        masks.append(decoded)
                                except UnicodeError:
                                    invalid.set()
                        line, oversized = b"", False
            if line.startswith(MASK_PREFIX):
                invalid.set()  # a truncated registration must not silently succeed
        except OSError:
            invalid.set()
        finally:
            pipe.close()

    threads = [threading.Thread(target=drain, args=(pipe, index), daemon=True)
               for index, pipe in enumerate((process.stdout, process.stderr))]
    for thread in threads:
        thread.start()
    failure = None
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        failure = CheckFailure("timeout")
        terminate_group(process)
    except BaseException:
        terminate_group(process)
        raise
    finally:
        for thread in threads:
            thread.join(timeout=2)
        if any(thread.is_alive() for thread in threads):
            terminate_group(process)
            for thread in threads:
                thread.join(timeout=2)
            failure = CheckFailure("tool_error")
    # The runner consumes these registrations before it processes the action's
    # GITHUB_ENV/OUTPUT files. No other child workflow command is replayed.
    for mask in masks:
        print(mask, flush=True)
    if failure:
        raise failure
    if invalid.is_set():
        raise CheckFailure("invalid_data")
    stdout, stderr = (bytes(value).decode("utf-8", errors="replace") for value in prefixes)
    if process.returncode:
        raise CheckFailure(command_failure(stdout, stderr + "\n" + stdout))
    return stdout


def bundle_path(env, name):
    path = private_directory(env) / name
    if path.is_symlink() or not path.is_file():
        raise CheckFailure("invalid_data")
    if hashlib.sha256(path.read_bytes()).hexdigest() != BUNDLES[name][3]:
        raise CheckFailure("invalid_data")
    return path


def prepare(env):
    directory = private_directory(env)
    # Export to later run steps too, including the separately redacted topology
    # checker. The runner's file-command paths are public ephemeral paths.
    configuration = isolated_configuration(env)
    if not env.get("GITHUB_ENV") or any("\n" in value or "\r" in value for value in configuration.values()):
        raise CheckFailure("invalid_data")
    with open(env["GITHUB_ENV"], "a", encoding="utf-8") as output:
        for key, value in configuration.items():
            output.write(key + "=" + value + "\n")
    opener = build_opener(ProxyHandler({}), NoRedirect())
    for name, (repository, commit, relative, expected) in BUNDLES.items():
        url = f"https://raw.githubusercontent.com/google-github-actions/{repository}/{commit}/{relative}"
        with opener.open(url, timeout=30) as response:
            data = response.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected:
            raise CheckFailure("invalid_data")
        destination = directory / name
        if destination.is_symlink():
            raise CheckFailure("invalid_data")
        destination.write_bytes(data)
        destination.chmod(0o600)
    return True


def action(env, name, inputs, *, public_setup=False):
    child = child_environment(env)
    if public_setup:
        for key in ("GOOGLE_GHA_CREDS_PATH", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
                    "GCP_PROJECT", "GCP_WIF_PROVIDER", "GCP_DEPLOYER_SA", "GKE_CLUSTER", "GAR_REGISTRY"):
            child.pop(key, None)
    repository, commit, _, _ = BUNDLES[name]
    child.update(GITHUB_ACTION_REPOSITORY="google-github-actions/" + repository,
                 GITHUB_ACTION_REF=commit, GITHUB_ACTION_PATH=str(private_directory(env)))
    child.update({"INPUT_" + key.upper(): value for key, value in inputs.items()})
    if not re.fullmatch(r"v(?:2[4-9]|[3-9][0-9])\.[0-9]+\.[0-9]+\s*", captured(["node", "--version"], child)):
        raise CheckFailure("invalid_data")
    captured(["node", str(bundle_path(env, name))], child, timeout=900, action_masks=True)
    return True


def auth_inputs(env):
    values = [env.get(key, "") for key in ("GCP_PROJECT", "GCP_WIF_PROVIDER", "GCP_DEPLOYER_SA")]
    if not all(values):
        raise CheckFailure("invalid_data")
    return dict(project_id=values[0], workload_identity_provider=values[1], service_account=values[2],
                create_credentials_file="true", export_environment_variables="true", cleanup_credentials="true",
                universe="googleapis.com", token_format="", credentials_json="")


def release(env):
    tag, commit, registry = env.get("TAG", ""), env.get("GITHUB_SHA", ""), env.get("GAR_REGISTRY", "")
    if not tag.startswith("v") or not VERSION.fullmatch(tag[1:]) or not COMMIT.fullmatch(commit):
        raise CheckFailure("invalid_data")
    if not registry or any(char.isspace() for char in registry) or "://" in registry or "@" in registry or "?" in registry or "#" in registry:
        raise CheckFailure("invalid_data")
    return tag[1:], commit, registry


def cleanup(env):
    directory = private_directory(env)
    ok, credential = True, None
    try:
        value = env.get("GOOGLE_GHA_CREDS_PATH")
        if value:
            candidate = Path(value)
            workspace = Path(env.get("GITHUB_WORKSPACE", ""))
            # Check before the bundled post action too: it removes the supplied
            # path recursively and must never receive an unrelated path.
            if (not workspace.is_absolute() or not candidate.is_absolute()
                    or candidate.parent.resolve() != workspace.resolve()
                    or not re.fullmatch(r"gha-creds-[0-9a-f]+\.json", candidate.name)
                    or candidate.is_symlink() or (candidate.exists() and not candidate.is_file())):
                raise CheckFailure("invalid_data")
            credential = candidate
            action(env, "auth-post.js", {"create_credentials_file": "true", "cleanup_credentials": "true"})
    except Exception:
        ok = False
    finally:
        # Also remove a credential file if the bundled post step failed. Limit
        # deletion to the auth action's own basename in this runner workspace.
        try:
            if credential is not None:
                credential.unlink(missing_ok=True)
        finally:
            shutil.rmtree(directory)
    return ok


def execute(stage, env):
    if stage == "prepare":
        return prepare(env)
    if stage == "install_sdk":
        return action(env, "setup-gcloud.js", {"version": "latest", "install_components": "gke-gcloud-auth-plugin", "skip_install": "false", "cache": "false"}, public_setup=True)
    if stage == "authenticate":
        return action(env, "auth-main.js", auth_inputs(env))
    if stage == "configure_sdk":
        return action(env, "setup-gcloud.js", {"skip_install": "true", "version": "", "install_components": "", "cache": "false"})
    if stage == "cleanup":
        return cleanup(env)
    child = child_environment(env)
    directory = private_directory(env)
    if stage == "cluster_credentials":
        if not env.get("GKE_CLUSTER") or not env.get("GCP_PROJECT"):
            raise CheckFailure("invalid_data")
        captured(["gcloud", "container", "fleet", "memberships", "get-credentials", env["GKE_CLUSTER"], "--project", env["GCP_PROJECT"], "--quiet"], child)
    elif stage == "rollout":
        for name in ("ask-a-human-relay", "ask-a-human-web"):
            captured(["kubectl", "rollout", "status", "deploy/" + name, "-n", "ask-a-human", "--timeout=180s"], child, timeout=210)
    else:
        version, commit, registry = release(env)
        if stage == "configure_registry":
            captured(["gcloud", "auth", "configure-docker", registry.split("/", 1)[0], "--quiet"], child)
        elif stage == "build_relay":
            captured(["go", "install", "github.com/google/ko@v0.18.1"], child, cwd=ROOT / "backend", timeout=900)
            gopath = captured(["go", "env", "GOPATH"], child, cwd=ROOT / "backend").strip()
            if not Path(gopath).is_absolute() or "\n" in gopath:
                raise CheckFailure("invalid_data")
            child.update(KO_DOCKER_REPO=registry + "/relay", AAH_BUILD_VERSION=version, AAH_BUILD_COMMIT=commit)
            captured([str(Path(gopath) / "bin/ko"), "build", "--bare", "--platform=linux/amd64", "--tags", version + ",latest", "./cmd/relay"], child, cwd=ROOT / "backend", timeout=1200)
        elif stage == "build_web":
            captured(["docker", "buildx", "build", "--push", "--build-arg", "PUBLIC_BUILD_VERSION=" + version,
                      "--build-arg", "PUBLIC_BUILD_COMMIT=" + commit, "-t", registry + "/web:" + version,
                      "-t", registry + "/web:latest", "frontend"], child, timeout=1200)
        elif stage == "apply":
            manifests = directory / "infra"
            if manifests.exists():
                shutil.rmtree(manifests)
            for name in ("base", "prod"):
                shutil.copytree(ROOT / "infra" / name, manifests / name)
            captured(["kustomize", "edit", "set", "image", "ask-a-human-relay=" + registry + "/relay:" + version,
                      "ask-a-human-web=" + registry + "/web:" + version], child, cwd=manifests / "prod")
            captured(["kubectl", "apply", "-k", ".", "-o", "name"], child, cwd=manifests / "prod")
        else:
            raise CheckFailure("invalid_data")
    return True


def main():
    report = Report()
    if len(sys.argv) != 2 or sys.argv[1] not in STAGES:
        report.check("cloud_workflow_inputs", lambda: False)
        return 1
    stage = sys.argv[1]
    report.check("cloud_" + stage, lambda: execute(stage, dict(os.environ)))
    return 0 if report.ok else 1


if __name__ == "__main__":
    # Interruptions must unwind captured child process groups without a raw
    # traceback or private command arguments reaching a public runner log.
    def interrupted(_signal, _frame):
        raise InterruptedError()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    raise SystemExit(main())
