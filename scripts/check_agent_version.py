#!/usr/bin/env python3
"""Build and run real CLI artifacts; no agent startup, user config or network."""
import json
import subprocess
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "backend"
PACKAGE = "github.com/askahuman/askahuman/backend/pkg/buildinfo"


def run(args):
    return subprocess.check_output(args, cwd=BACKEND, text=True).strip()


with tempfile.TemporaryDirectory(prefix="aah-version-") as directory:
    binary = str(Path(directory) / "agent")
    for version, commit, flags in [
        ("dev", "unknown", []),
        ("1.2.3", "0123456789012345678901234567890123456789", ["-ldflags",
         f"-X {PACKAGE}.Version=1.2.3 -X {PACKAGE}.Commit=0123456789012345678901234567890123456789"]),
    ]:
        run(["go", "build", "-trimpath", *flags, "-o", binary, "./cmd/agent"])
        assert json.loads(run([binary, "version", "--json"])) == {"version": version, "commit": commit}
        assert run([binary, "version"]) == f"ask-a-human {version} ({commit})"
        assert run([binary, "--version"]) == f"ask-a-human {version} ({commit})"
        invalid = subprocess.run([binary, "version", "extra"], capture_output=True, check=False)
        assert invalid.returncode != 0 and not invalid.stdout
print("Development and release CLI artifacts report their public build identity.")
