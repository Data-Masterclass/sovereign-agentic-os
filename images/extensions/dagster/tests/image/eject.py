# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Eject test — a generated domain repo runs on plain dbt with no OS present (owner's acceptance rule).

Runs in a bare `python` container that has ONLY dbt-core + dbt-trino installed (the versions read
back from the Dagster image, see run.sh) and reaches a stock Trino. For each generator golden:
commit it to a git repo, `git clone` it, then `dbt parse` and `dbt compile --target local` in the
clone. The environment holds only standard Trino connection settings: no OS_* variable, no
Dagster, no OS image, no OS process. Any `env_var()` / `var()` / macro / package the project needs
from the OS at runtime fails this test.
"""
import glob
import json
import os
import subprocess
import sys
import tempfile

SRC = os.environ.get("SRC", "/src")
GOLDENS = sorted(glob.glob(os.path.join(SRC, "os-ui/tabs/data/lib/dbt/fixtures/*.golden.json")))
ENV = {
    "PATH": os.environ["PATH"],
    "HOME": tempfile.mkdtemp(),
    "DBT_SEND_ANONYMOUS_USAGE_STATS": "false",
    "TRINO_HOST": os.environ["TRINO_HOST"],
    "TRINO_PORT": os.environ.get("TRINO_PORT", "8080"),
    "TRINO_USER": "alice",
}
assert not [k for k in ENV if k.startswith("OS_")]


def run(cmd, cwd):
    p = subprocess.run(cmd, cwd=cwd, env=ENV, capture_output=True, text=True, timeout=600)
    return p.returncode, p.stdout + p.stderr


def main():
    assert GOLDENS, "no goldens found"
    failures = []
    for g in GOLDENS:
        name = os.path.basename(g)
        with tempfile.TemporaryDirectory() as tmp:
            origin, clone = os.path.join(tmp, "origin"), os.path.join(tmp, "clone")
            for path, content in json.load(open(g)).items():
                full = os.path.join(origin, path)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                open(full, "w").write(content)
            gitenv = ["-c", "user.name=t", "-c", "user.email=t@t"]
            for c in (["init", "-q", "-b", "main"], ["add", "."], [*gitenv, "commit", "-q", "-m", "domain repo"]):
                subprocess.run(["git", *c], cwd=origin, check=True, capture_output=True)
            subprocess.run(["git", "clone", "-q", origin, clone], check=True, capture_output=True)
            for step in (["dbt", "parse", "--profiles-dir", ".", "--target", "local", "--no-use-colors"],
                         ["dbt", "compile", "--profiles-dir", ".", "--target", "local", "--no-use-colors"]):
                code, out = run(step, clone)
                verdict = "ok" if code == 0 else "FAIL"
                print(f"{verdict:4} {name}: {' '.join(step[:2])}")
                if code != 0:
                    failures.append(name)
                    print(out[-2500:])
                    break
            else:
                compiled = glob.glob(os.path.join(clone, "target/compiled/**/*.sql"), recursive=True)
                if not compiled:
                    failures.append(name)
                    print(f"FAIL {name}: dbt compile wrote no compiled SQL")
    if failures:
        print(f"eject: {len(failures)} of {len(GOLDENS)} domain repos need the OS to run: {failures}")
        return 1
    print(f"eject: all {len(GOLDENS)} domain repos parse and compile on plain dbt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
