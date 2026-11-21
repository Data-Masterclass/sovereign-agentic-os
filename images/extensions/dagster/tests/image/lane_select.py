# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""A sync schedule selects only models in its owner's lane — judged by the real dbt in the image.

Run IN the Dagster image (run.sh): real dbt-core resolves the selection strings the OS generates
(os-ui tabs/data/lib/dbt/schedules.ts: `<model>+,path:<owner's dir>` for a personal-lane landing;
`<model>+,config.meta.os_owner:<owner>` with `--exclude path:models/personal` for a domain-lane one).
  - personal landing of bea: her own lane only (not amir's personal model, not a shared model);
  - domain landing of bea: only bea's shared-path models (not amir's shared model, no personal lane);
  - Twin: the plain `<model>+` selects another owner's personal AND shared models downstream.
"""
import os
import subprocess
import tempfile

P = tempfile.mkdtemp()
for d in ("models/personal/bea", "models/personal/amir", "models/silver"):
    os.makedirs(os.path.join(P, d))
w = lambda rel, text: open(os.path.join(P, rel), "w").write(text)  # noqa: E731
w("dbt_project.yml", "name: lane\nversion: '1.0.0'\nconfig-version: 2\nprofile: p\nmodel-paths: [models]\n")
w("profiles.yml", "p:\n  target: t\n  outputs:\n    t: {type: trino, method: none, host: h, port: 8080, user: u, database: iceberg, schema: s, threads: 1}\n")
w("models/personal/bea/bronze_a.sql", "select 1 as x\n")
for rel in ("models/personal/bea/silver_a2.sql", "models/personal/amir/silver_b.sql", "models/silver/silver_c.sql", "models/silver/silver_d.sql"):
    w(rel, "select * from {{ ref('bronze_a') }}\n")
w("models/schema.yml", "version: 2\nmodels:\n" + "".join(
    f"  - {{name: {n}, meta: {{os_owner: {o}}}}}\n" for n, o in
    (("bronze_a", "bea"), ("silver_a2", "bea"), ("silver_b", "amir"), ("silver_c", "amir"), ("silver_d", "bea"))))
ENV = {**os.environ, "DBT_PROFILES_DIR": P, "DBT_SEND_ANONYMOUS_USAGE_STATS": "false", "HOME": "/tmp"}


def ls(select: str, exclude: str = "") -> set:
    cmd = ["dbt", "ls", "--resource-type", "model", "--output", "name", "--project-dir", P, "--select", select]
    if exclude:
        cmd += ["--exclude", exclude]
    out = subprocess.run(cmd, env=ENV, capture_output=True, text=True, check=True).stdout
    return {line.strip() for line in out.splitlines() if line.strip() in {"bronze_a", "silver_a2", "silver_b", "silver_c", "silver_d"}}


fails = []


def check(name, got, want):
    ok = got == want
    print(("  ok   " if ok else "  FAIL ") + name + ("" if ok else f"\n     got {sorted(got)} want {sorted(want)}"))
    if not ok:
        fails.append(name)


check("personal landing of bea selects her own lane only", ls("bronze_a+,path:models/personal/bea"), {"bronze_a", "silver_a2"})
check("domain landing of bea selects only bea's shared-path models",
      ls("bronze_a+,config.meta.os_owner:bea", "path:models/personal"), {"silver_d"})
check("TWIN: the plain <model>+ also selects amir's personal and shared models",
      ls("bronze_a+"), {"bronze_a", "silver_a2", "silver_b", "silver_c", "silver_d"})
check("TWIN: without the exclusion a domain landing would still take bea's personal models",
      ls("bronze_a+,config.meta.os_owner:bea"), {"bronze_a", "silver_a2", "silver_d"})
raise SystemExit(1 if fails else 0)
