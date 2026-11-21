# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""The dbt subprocess a run starts gets only what dbt and dbt-trino need — no credential of the pod.

Run IN the Dagster image (run.sh): the real dagster-dbt `DbtCliResource` and the real dbt-core.
A model renders `env_var()` for a pod credential and for a Trino setting; `dbt parse` prints the
rendered values through dbt's own `log()`.
  - repo.py's resource: the credentials render as their default, the Trino setting passes, and
    the pod's own environment is unchanged afterwards.
  - Negative twin: the stock `DbtCliResource` renders the credentials (so the test can see a leak).
  - The wrapper swaps the resource in a repo's own native Definitions too.
"""
import json
import os
import sys
import tempfile

PROJECT = tempfile.mkdtemp()
os.makedirs(os.path.join(PROJECT, "models"))
open(os.path.join(PROJECT, "dbt_project.yml"), "w").write("name: envcheck\nversion: '1.0'\nconfig-version: 2\nprofile: p\nmodel-paths: [models]\n")
open(os.path.join(PROJECT, "profiles.yml"), "w").write(
    "p:\n  target: t\n  outputs:\n    t:\n      type: trino\n      method: none\n"
    "      host: \"{{ env_var('TRINO_HOST') }}\"\n      port: 8080\n      user: u\n      catalog: iceberg\n      schema: s\n"
)
LEAKS = {"DAGSTER_PG_PASSWORD": "pg-s3cret-value", "AGENT_RUNTIME_TOKEN": "bearer-s3cret-value", "AWS_SECRET_ACCESS_KEY": "aws-s3cret-value", "SOME_API_KEY": "key-s3cret-value",
         # Names that look like a dbt or Trino setting: only exact names pass.
         "TRINO_PASSWORD": "trino-s3cret-value", "DBT_ENV_CUSTOM_ENV_SECRET": "dbt-custom-s3cret-value"}
model = "".join(f"{{{{ log('ENV {k}=' ~ env_var('{k}', 'absent'), info=True) }}}}\n" for k in LEAKS)
model += "{{ log('ENV TRINO_HOST=' ~ env_var('TRINO_HOST', 'absent'), info=True) }}\nselect 1 as x\n"
open(os.path.join(PROJECT, "models", "m.sql"), "w").write(model)

os.environ.update(LEAKS)
os.environ["TRINO_HOST"] = "trino-host-for-dbt"
os.environ.setdefault("REPO_SYNC_CHECKOUT", tempfile.mkdtemp())
sys.path.insert(0, "/opt/dagster/app")
from dagster import Definitions  # noqa: E402
from dagster_dbt import DbtCliResource  # noqa: E402

import repo  # noqa: E402


def rendered(resource) -> dict:
    inv = resource.cli(["parse", "--no-partial-parse"], raise_on_error=False)
    out = {}
    for ev in inv.stream_raw_events():
        msg = (ev.raw_event.get("info") or {}).get("msg") or ""
        if msg.startswith("ENV "):
            k, _, v = msg[4:].partition("=")
            out[k] = v
    inv.wait()
    return out


fail = []
scrubbed = rendered(repo.ScrubbedDbtCliResource(project_dir=PROJECT, profiles_dir=PROJECT))
for k in LEAKS:
    if scrubbed.get(k) != "absent":
        fail.append(f"repo.py resource: dbt rendered {k} (got {scrubbed.get(k)!r})")
if scrubbed.get("TRINO_HOST") != "trino-host-for-dbt":
    fail.append(f"repo.py resource: dbt lost a Trino setting it needs (TRINO_HOST={scrubbed.get('TRINO_HOST')!r})")
for k, v in LEAKS.items():
    if os.environ.get(k) != v:
        fail.append(f"the pod's own environment changed: {k}")

stock = rendered(DbtCliResource(project_dir=PROJECT, profiles_dir=PROJECT))
if stock.get("DAGSTER_PG_PASSWORD") != LEAKS["DAGSTER_PG_PASSWORD"]:
    fail.append(f"negative twin: the stock resource did not render the credential ({stock}) — the test cannot see a leak")

native = Definitions(resources={"dbt": DbtCliResource(project_dir=PROJECT, profiles_dir=PROJECT)})
swapped = repo._scrubbed_resources(native.resources)
if not isinstance(swapped["dbt"], repo.ScrubbedDbtCliResource) or swapped["dbt"].project_dir != PROJECT:
    fail.append(f"native definitions: the repo's DbtCliResource was not swapped ({swapped})")

# With a real Trino (run.sh passes REAL_TRINO_HOST): a `dbt build` through the narrowed env works.
real = os.environ.get("REAL_TRINO_HOST")
if real:
    os.environ["TRINO_HOST"] = real
    inv = repo.ScrubbedDbtCliResource(project_dir=PROJECT, profiles_dir=PROJECT).cli(["build"], raise_on_error=False)
    list(inv.stream_raw_events())
    if not inv.is_successful():
        fail.append("dbt build through the narrowed env failed against a real Trino")
    else:
        print("dbt build through the narrowed env: ok on a real Trino")

print(json.dumps({"scrubbed": scrubbed, "stock": {k: ("<leaked>" if v in LEAKS.values() else v) for k, v in stock.items()}}))
if fail:
    print("\n".join("FAIL " + f for f in fail))
    raise SystemExit(1)
print("dbt_env: ok — the dbt subprocess sees no pod credential, and keeps what dbt-trino needs")
