#!/usr/bin/env python3
"""Publish only the npm wrapper for an existing stable GitHub release.

All remote/child output stays private. Only fixed checks and failure categories
cross stdout; the existing reviewed capture helper also bounds child output.
The registry host is fixed; this never modifies release assets, Git tags, or
deployments. Asset metadata is checked here, not cryptographic signatures or
provenance: the operator must verify those before dispatching recovery.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tarfile
import tempfile
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, ProxyHandler

from private_cloud import NoRedirect, captured
from production_preflight import CheckFailure, COMMIT, Report

REPOSITORY = "askahuman/askahuman"
REGISTRY = "https://registry.npmjs.org"
PACKAGE = "@askahuman/mcp"
STABLE = re.compile(r"v(0|[1-9][0-9]{0,15})\.(0|[1-9][0-9]{0,15})\.(0|[1-9][0-9]{0,15})\Z")
FILES = ("package.json", "install.js", "bin/cli.js")
ASSETS = frozenset({"checksums.txt", "checksums.txt.sigstore.json"} | {
    f"ask-a-human_{system}_{arch}.{'zip' if system == 'windows' else 'tar.gz'}"
    for system in ("darwin", "linux", "windows") for arch in ("amd64", "arm64")
})


def require(predicate):
    if not predicate:
        raise CheckFailure("invalid_data")


def version_tuple(tag):
    match = STABLE.fullmatch(tag) if isinstance(tag, str) else None
    require(match is not None)
    result = tuple(int(part) for part in match.groups())
    require(all(part <= 9007199254740991 for part in result))
    return result


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: require(False))


def read_json(url, token=None, *, missing=False):
    # Callers construct URLs exclusively from constants and validated tag/SHA.
    headers = {"Accept": "application/json", "User-Agent": "askahuman-npm-recovery"}
    if token:
        require(url.startswith(f"https://api.github.com/repos/{REPOSITORY}/"))
        headers.update({"Authorization": "Bearer " + token,
                        "X-GitHub-Api-Version": "2022-11-28"})
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        with opener.open(Request(url, headers=headers), timeout=30) as response:
            data = response.read(2 * 1024 * 1024 + 1)
        require(len(data) <= 2 * 1024 * 1024)
        return strict_json(data)
    except HTTPError as error:
        if missing and error.code == 404:
            return None
        raise CheckFailure({401: "unauthenticated", 403: "forbidden", 404: "not_found",
                            429: "rate_limited"}.get(error.code, "api_error")) from None
    except (TimeoutError, URLError):
        raise CheckFailure("network_error") from None


def resolve_release(tag, token=None, *, read=None):
    read = read or read_json
    version_tuple(tag)
    api = f"https://api.github.com/repos/{REPOSITORY}"
    release = read(f"{api}/releases/tags/{tag}", token)
    require(isinstance(release, dict) and release.get("tag_name") == tag
            and release.get("draft") is False and release.get("prerelease") is False
            and isinstance(release.get("published_at"), str) and release["published_at"]
            and type(release.get("id")) is int and release["id"] > 0)
    assets = release.get("assets")
    require(isinstance(assets, list) and len(assets) <= 100)
    names = set()
    for asset in assets:
        require(isinstance(asset, dict) and isinstance(asset.get("name"), str))
        name = asset["name"]
        require(name not in names)
        names.add(name)
        if name in ASSETS:
            require(asset.get("state") == "uploaded" and type(asset.get("size")) is int
                    and asset["size"] > 0 and asset.get("browser_download_url") ==
                    f"https://github.com/{REPOSITORY}/releases/download/{tag}/{name}")
    require(ASSETS <= names)
    ref = read(f"{api}/git/ref/tags/{tag}", token)
    require(isinstance(ref, dict) and ref.get("ref") == "refs/tags/" + tag)
    obj = ref.get("object")
    for _ in range(5):
        require(isinstance(obj, dict) and isinstance(obj.get("sha"), str)
                and COMMIT.fullmatch(obj["sha"]))
        if obj.get("type") == "commit":
            return {"commit": obj["sha"], "release_id": release["id"]}
        require(obj.get("type") == "tag")
        annotated = read(f"{api}/git/tags/{obj['sha']}", token)
        require(isinstance(annotated, dict) and annotated.get("sha") == obj["sha"])
        obj = annotated.get("object")
    raise CheckFailure("invalid_data")


def clean_environment(env):
    # No npm config, proxy, Node preload, GitHub token, or unrelated credentials
    # may redirect publication or execute code in a child. HOME is not changed.
    return {name: env[name] for name in ("PATH", "TMPDIR", "LANG", "LC_ALL") if name in env}


def prepare_package(source, commit, tag, directory, env, *, run=captured):
    version_tuple(tag)
    require(isinstance(commit, str) and COMMIT.fullmatch(commit))
    child = clean_environment(env)
    require(run(["git", "rev-parse", "HEAD"], child, cwd=source).strip() == commit)
    entries = run(["git", "ls-tree", "-r", commit, "--", *("npm/" + name for name in FILES)],
                  child, cwd=source).splitlines()
    require(len(entries) == len(FILES) and all(re.fullmatch(
        r"100(?:644|755) blob [0-9a-f]{40}\tnpm/(?:package\.json|install\.js|bin/cli\.js)", entry)
        for entry in entries))
    package_dir = directory / "package"
    package_dir.mkdir(mode=0o700)
    (package_dir / "bin").mkdir(mode=0o700)
    # Read the immutable commit, not worktree files (which may contain generated
    # binaries, credentials, or untracked files after a previous operation).
    contents = {}
    for name in FILES:
        raw = run(["git", "show", f"{commit}:npm/{name}"], child, cwd=source)
        require(len(raw.encode("utf-8")) < 65536 and "\ufffd" not in raw)
        contents[name] = raw
    manifest = strict_json(contents["package.json"])
    require(isinstance(manifest, dict) and manifest.get("name") == PACKAGE
            and manifest.get("files") == ["bin/cli.js", "install.js"]
            and manifest.get("bin") == {"askahuman": "bin/cli.js"}
            and manifest.get("scripts") == {"postinstall": "node install.js"}
            and manifest.get("publishConfig") == {"access": "public"}
            and not any(key in manifest for key in ("dependencies", "optionalDependencies",
                        "bundledDependencies", "bundleDependencies", "workspaces", "private")))
    manifest["version"] = tag[1:]
    contents["package.json"] = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    for name, raw in contents.items():
        path = package_dir / name
        path.write_text(raw, encoding="utf-8")
        path.chmod(0o755 if name == "bin/cli.js" else 0o644)
    userconfig, globalconfig = directory / "npmrc", directory / "global-npmrc"
    userconfig.write_text(f"registry={REGISTRY}\n@askahuman:registry={REGISTRY}\n", encoding="utf-8")
    globalconfig.write_text("", encoding="utf-8")
    userconfig.chmod(0o600)
    globalconfig.chmod(0o600)
    common = ["--ignore-scripts", "--registry=" + REGISTRY, "--userconfig=" + str(userconfig),
              "--globalconfig=" + str(globalconfig), "--cache=" + str(directory / "cache"),
              "--logs-max=0", "--fetch-retries=0", "--fetch-timeout=30000"]
    result = strict_json(run(["npm", "pack", "--json", "--pack-destination=" + str(directory),
                              *common], child, cwd=package_dir))
    filename = "askahuman-mcp-" + tag[1:] + ".tgz"
    require(isinstance(result, list) and len(result) == 1 and isinstance(result[0], dict)
            and result[0].get("filename") == filename)
    archive = directory / filename
    require(archive.is_file() and not archive.is_symlink() and archive.stat().st_size <= 65536)
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        require(len(members) == len(FILES) and {member.name for member in members} ==
                {"package/" + name for name in FILES})
        for member in members:
            require(member.isfile() and member.size <= 65536)
            data = tar.extractfile(member).read()
            name = member.name.removeprefix("package/")
            if name == "package.json":
                require(strict_json(data) == manifest)
            else:
                require(data == contents[name].encode("utf-8"))
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode("ascii")
    return archive, common, userconfig, integrity


def registry_state(tag, *, read=None):
    read = read or read_json
    desired = version_tuple(tag)
    metadata = read(REGISTRY + "/@askahuman%2fmcp", missing=True)
    if metadata is None:
        return True
    require(isinstance(metadata, dict) and metadata.get("name") == PACKAGE
            and isinstance(metadata.get("versions"), dict)
            and isinstance(metadata.get("dist-tags"), dict))
    require(tag[1:] not in metadata["versions"])
    latest = metadata["dist-tags"].get("latest")
    require(isinstance(latest, str) and version_tuple("v" + latest) <= desired)
    return True


def main(env=None):
    env = dict(os.environ if env is None else env)
    report = Report()
    tag = env.get("RELEASE_TAG", "")
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    if not report.check("npm_recovery_input", lambda: (
            env.get("GITHUB_ACTIONS") == "true" and env.get("GITHUB_REPOSITORY") == REPOSITORY
            and env.get("GITHUB_REF") == "refs/heads/main" and mode in {"resolve", "publish"}
            and bool(version_tuple(tag)))):
        return 1
    resolved = {}

    def resolve():
        resolved.update(resolve_release(tag, env.get("GH_TOKEN")))
        return True

    if not report.check("npm_recovery_release", resolve):
        return 1
    if mode == "resolve":
        def output():
            with open(env["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
                stream.write("commit=" + resolved["commit"] + "\n")
                stream.write("release_id=" + str(resolved["release_id"]) + "\n")
            return True
        return 0 if report.check("npm_recovery_resolved_commit", output) else 1
    if not report.check("npm_recovery_same_release", lambda: (
            env.get("RELEASE_COMMIT") == resolved["commit"]
            and env.get("RELEASE_ID") == str(resolved["release_id"]))):
        return 1
    # Everything created here, including npm's cache/error logs, is removed even
    # when packing, publication, or the final registry integrity check fails.
    with tempfile.TemporaryDirectory(prefix="aah-npm-recovery-") as temporary:
        prepared = []

        def package():
            prepared.extend(prepare_package(Path(env["RELEASE_SOURCE"]), resolved["commit"],
                                            tag, Path(temporary), env))
            return True

        if not report.check("npm_recovery_package", package):
            return 1
        if not report.check("npm_recovery_registry_available", lambda: registry_state(tag)):
            return 1
        if not report.check("npm_recovery_release_unchanged", lambda:
                            resolve_release(tag, env.get("GH_TOKEN")) == resolved):
            return 1
        archive, common, userconfig, integrity = prepared

        def publish():
            token = env.get("NODE_AUTH_TOKEN", "")
            require(token and not any(ord(char) < 33 or ord(char) > 126 for char in token))
            # Store an environment reference, never the credential value.
            with userconfig.open("a", encoding="utf-8") as stream:
                stream.write("//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n")
            child = dict(clean_environment(env), NODE_AUTH_TOKEN=token)
            captured(["npm", "publish", str(archive), "--access=public", "--tag=latest", *common],
                     child, cwd=archive.parent, timeout=180)
            return True

        if not report.check("npm_recovery_publish", publish):
            return 1

        def verify():
            value = read_json(REGISTRY + "/@askahuman%2fmcp/" + tag[1:])
            return (isinstance(value, dict) and value.get("name") == PACKAGE
                    and value.get("version") == tag[1:] and isinstance(value.get("dist"), dict)
                    and value["dist"].get("integrity") == integrity)

        return 0 if report.check("npm_recovery_registry_integrity", verify) else 1


if __name__ == "__main__":
    try:
        result = main()
    except (Exception, KeyboardInterrupt):
        # Even unexpected filesystem/transport errors may contain private paths.
        print('{"check":"npm_recovery_internal","ok":false,"failure":"tool_error"}', flush=True)
        result = 1
    sys.exit(result)
