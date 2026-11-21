# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""A sync schedule selects only the OS-generated models of its owner — judged by the real Dagster in the image.

Run IN the Dagster image (run.sh). The selection the OS generates (os-ui tabs/data/lib/dbt/
dagster-definitions.ts) is `AssetSelection.assets(<landing>).downstream() & AssetSelection.assets(<the
owner's OS-generated models>)`; this resolves it on a real asset graph that holds an author-added model
downstream of the landing table which labels itself with the owner in its own metadata.
  - the selection contains the owner's models and neither another owner's model nor the author-added one;
  - Twin: the plain downstream selection contains the author-added model (the case this prevents);
  - the detective (os_projects.out_of_lane_models) flags exactly the models the selection excludes;
  - real dbt: a model whose NAME equals a directory selects that whole directory when given as a bare
    name, and only itself when given as an exact `path:<file>` (what the schedules use).
"""
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, "/opt/dagster/app")
import dagster as dg  # noqa: E402

import os_projects as osp  # noqa: E402

K = lambda n: dg.AssetKey(["sales", n])  # noqa: E731


@dg.asset(key=K("bronze_a"))
def bronze_a(): ...


@dg.asset(key=K("silver_a2"), deps=[K("bronze_a")])
def silver_a2(): ...


@dg.asset(key=K("silver_b"), deps=[K("bronze_a")])  # another owner's model
def silver_b(): ...


# Added by an author in a shared path; its own metadata claims the owner.
@dg.asset(key=K("author_added_model"), deps=[K("bronze_a")], metadata={"os_owner": "bea"})
def author_added_model(): ...


graph = dg.Definitions(assets=[bronze_a, silver_a2, silver_b, author_added_model]).resolve_asset_graph()
OWNERS = {"bronze_a": "bea", "silver_a2": "bea", "silver_b": "amir"}  # os/generated.yml `owners`
mine = [K(n) for n, o in OWNERS.items() if o == "bea"]
names = lambda sel: {k.path[-1] for k in sel.resolve(graph)}  # noqa: E731

fails = []


def check(name, got, want):
    ok = got == want
    print(("  ok   " if ok else "  FAIL ") + name + ("" if ok else f"\n     got {sorted(got)} want {sorted(want)}"))
    if not ok:
        fails.append(name)


selected = names(dg.AssetSelection.assets(K("bronze_a")).downstream() & dg.AssetSelection.assets(*mine))
check("the owner's schedule selects only her OS-generated models", selected, {"bronze_a", "silver_a2"})
twin = names(dg.AssetSelection.assets(K("bronze_a")).downstream())
check("TWIN: the plain downstream also takes another owner's model and the author-added one", twin, {"bronze_a", "silver_a2", "silver_b", "author_added_model"})
check("the detective flags exactly what the selection leaves out of the twin (meta is never read)",
      set(osp.out_of_lane_models(OWNERS, twin, "bea")), {"silver_b", "author_added_model"})
check("the detective is silent for the generated selection", osp.out_of_lane_models(OWNERS, selected, "bea"), [])

# ---- real dbt: bare name vs exact file path -------------------------------------------------------
P = tempfile.mkdtemp()
os.makedirs(os.path.join(P, "models", "silver"))
w = lambda rel, text: open(os.path.join(P, rel), "w").write(text)  # noqa: E731
w("dbt_project.yml", "name: lane\nversion: '1.0.0'\nconfig-version: 2\nprofile: p\nmodel-paths: [models]\n")
w("profiles.yml", "p:\n  target: t\n  outputs:\n    t: {type: trino, method: none, host: h, port: 8080, user: u, database: iceberg, schema: s, threads: 1}\n")
w("models/silver/silver.sql", "select 1 as x\n")  # named like its directory
w("models/silver/other_authors_model.sql", "select 2 as x\n")
ENV = {**os.environ, "DBT_PROFILES_DIR": P, "DBT_SEND_ANONYMOUS_USAGE_STATS": "false", "HOME": "/tmp"}


def ls(select):
    out = subprocess.run(["dbt", "ls", "--resource-type", "model", "--output", "name", "--project-dir", P, "--select", select],
                         env=ENV, capture_output=True, text=True, check=True).stdout
    return {x.strip() for x in out.splitlines() if x.strip() in {"silver", "other_authors_model"}}


check("TWIN: the bare name `silver` selects the whole directory, another author's model included", ls("silver"), {"silver", "other_authors_model"})
check("the exact path selects only that model", ls("path:models/silver/silver.sql"), {"silver"})
raise SystemExit(1 if fails else 0)
