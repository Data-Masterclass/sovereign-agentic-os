# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""A checked-in dbt parse cache must not change what the OS parses or runs — judged by the real dbt.

Run IN the Dagster image (run.sh). A project is parsed once; its `target/partial_parse.msgpack` is then
edited so the model's SQL says something else while the file checksums still match (what a pushed
`target/` can do). Then:
  - TWIN: a plain `dbt parse` trusts the tampered cache (the manifest carries the planted SQL);
  - `os_projects.dbt_parse` (purges target/, `--no-partial-parse`) reports the SQL of the file;
  - dbt with DBT_PARTIAL_PARSE=false (`os_projects.dbt_cli_env`, what a run uses) does too.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, "/opt/dagster/app")
import msgpack  # noqa: E402  (a dbt-core dependency)

import os_projects as osp  # noqa: E402

P = tempfile.mkdtemp()
os.makedirs(os.path.join(P, "models"))
w = lambda rel, text: open(os.path.join(P, rel), "w").write(text)  # noqa: E731
w("dbt_project.yml", "name: pp\nversion: '1.0.0'\nconfig-version: 2\nprofile: p\nmodel-paths: [models]\n")
w("profiles.yml", "p:\n  target: t\n  outputs:\n    t: {type: trino, method: none, host: h, port: 8080, user: u, database: iceberg, schema: s, threads: 1}\n")
w("models/m.sql", "select 1 as x\n")
ENV = {**os.environ, "DBT_PROFILES_DIR": P, "DBT_SEND_ANONYMOUS_USAGE_STATS": "false", "HOME": "/tmp"}
fails = []


def dbt(*args, env=ENV):
    subprocess.run(["dbt", *args, "--project-dir", P, "--quiet"], env=env, capture_output=True, text=True)


def planted_sql() -> str:
    m = json.load(open(os.path.join(P, "target", "manifest.json")))
    return next(n["raw_code"] for n in m["nodes"].values() if n.get("name") == "m")


def check(name, got, want):
    ok = got == want
    print(("  ok   " if ok else "  FAIL ") + name + ("" if ok else f"\n     got {got!r} want {want!r}"))
    if not ok:
        fails.append(name)


dbt("parse")
cache = os.path.join(P, "target", "partial_parse.msgpack")
BAD = os.path.join(tempfile.mkdtemp(), "bad.msgpack")
doc = msgpack.unpackb(open(cache, "rb").read(), raw=False, strict_map_key=False)


def tamper(x):
    if isinstance(x, dict):
        return {k: tamper(v) for k, v in x.items()}
    if isinstance(x, list):
        return [tamper(v) for v in x]
    return x.replace("select 1 as x", "select 666 as planted") if isinstance(x, str) else x


open(BAD, "wb").write(msgpack.packb(tamper(doc), use_bin_type=True))
shutil.copy(BAD, cache)

dbt("parse")
check("TWIN: a plain dbt parse trusts the tampered cache", "planted" in planted_sql(), True)

shutil.copy(BAD, cache)
code, _ = osp.dbt_parse(P, lambda cmd, cwd=None, env=None: subprocess.run(cmd, cwd=cwd, env={**ENV, **(env or {})}, capture_output=True, text=True).returncode and (1, "") or (0, ""), ENV)
check("os_projects.dbt_parse reports the SQL of the file, not of the cache", planted_sql().strip(), "select 1 as x")

dbt("parse")  # leaves a good cache; re-plant the tampered one and parse as a RUN does
shutil.copy(BAD, cache)
dbt("parse", env={**ENV, **osp.dbt_cli_env({"PATH": os.environ["PATH"]})})
check("dbt with DBT_PARTIAL_PARSE=false (a run) ignores the cache too", planted_sql().strip(), "select 1 as x")
raise SystemExit(1 if fails else 0)
