# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Write a generator golden out as a domain git repository in the design-12 layout.

FEATURE:    `repo_v2.py <golden.json> <out-dir> [--tamper-os-read]` — `git init` a domain repo whose
            dbt project is at `data/dbt/` and whose Dagster code location is `data/dagster/`, then
            commit it. `--tamper-os-read` is the eject NEGATIVE twin: it makes `definitions.py` read
            `os/schedules.yml` (what the image used to do) so a clone without the OS must fail.
USER STORY: As a reviewer I want the lakehouse and eject tests to run on exactly what the OS
            generator writes, in the layout a clone has.
ARCHITECTURE: stdlib only. The goldens are written by `os-ui/tabs/data/lib/dbt/generate.test.ts`
            with the dbt project at the root (the layout WP-55 migrates); everything outside `os/`
            and `data/` moves under `data/dbt/` here, which is that migration's `git mv` plan.
"""
import json
import os
import subprocess
import sys

DBT_DIR = "data/dbt"


def v2_path(p):
    return p if p.startswith("os/") or p.startswith("data/") else f"{DBT_DIR}/{p}"


def main(golden, out, tamper=False):
    files = json.load(open(golden))
    for p, content in files.items():
        full = os.path.join(out, v2_path(p))
        os.makedirs(os.path.dirname(full), exist_ok=True)
        if tamper and p == "data/dagster/definitions.py":
            content = content.replace("defs = dg.Definitions(", 'OS_SCHEDULES = (Path(__file__).resolve().parents[2] / "os/schedules.yml").read_text()\n\ndefs = dg.Definitions(', 1)
        open(full, "w").write(content)
    g = ["git", "-c", "user.name=t", "-c", "user.email=t@t"]
    for c in (["init", "-q", "-b", "main"], ["add", "."], ["commit", "-q", "-m", "domain repo"]):
        subprocess.run([*g, *c], cwd=out, check=True, capture_output=True)
    print(subprocess.run(["git", "rev-parse", "HEAD"], cwd=out, check=True, capture_output=True, text=True).stdout.strip())


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], "--tamper-os-read" in sys.argv[3:])
