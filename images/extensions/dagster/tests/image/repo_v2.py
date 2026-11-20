# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Write a generator golden out as a domain git repository in the design-12 layout.

FEATURE:    `repo_v2.py <golden.json> <out-dir> [--tamper-os-read] [--v1]` — `git init` a domain repo
            whose dbt project is at `data/dbt/` and whose Dagster code location is `data/dagster/`
            (with the WP-55 marker `os/layout.yml`), then commit it. `--v1` writes the unmigrated
            shape every live repo has while `layout.migration` is off: the dbt project at the root. `--tamper-os-read` is the eject NEGATIVE twin: it makes `definitions.py` read
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


def placed(files, v1):
    """What `os-ui/tabs/data/lib/dbt/layout.ts` `relocateProject` commits: v2 moves the dbt project
    under data/dbt and adds the layout marker; v1 (not migrated) keeps the root and carries no
    Dagster module and no hash record."""
    if v1:
        return {p: c for p, c in files.items() if not p.startswith("data/dagster/") and p != "os/generated.yml"}
    out = {v2_path(p): c for p, c in files.items()}
    out["os/layout.yml"] = f"version: 2\ndbt_project_dir: {DBT_DIR}\n"
    return out


def main(golden, out, tamper=False, v1=False):
    files = json.load(open(golden))
    for p, content in placed(files, v1).items():
        full = os.path.join(out, p)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        if tamper and p == "data/dagster/definitions.py":
            content = content.replace("defs = dg.Definitions(", 'OS_SCHEDULES = (Path(__file__).resolve().parents[2] / "os/schedules.yml").read_text()\n\ndefs = dg.Definitions(', 1)
        open(full, "w").write(content)
    g = ["git", "-c", "user.name=t", "-c", "user.email=t@t"]
    for c in (["init", "-q", "-b", "main"], ["add", "."], ["commit", "-q", "-m", "domain repo"]):
        subprocess.run([*g, *c], cwd=out, check=True, capture_output=True)
    print(subprocess.run(["git", "rev-parse", "HEAD"], cwd=out, check=True, capture_output=True, text=True).stdout.strip())


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], "--tamper-os-read" in sys.argv[3:], "--v1" in sys.argv[3:])
