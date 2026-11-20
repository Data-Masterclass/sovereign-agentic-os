# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Literal-safety image test — REAL `dbt parse` + `dbt compile` in the Dagster image, against a
stock Trino, on the generator's fuzz project and on its negative twin.

Run by run.sh (inside the Dagster image, on the Trino network). Inputs, both written by the
os-ui generator tests:
  * fixtures/literal-safety-fuzz.golden.json — every free-text payload of the fuzz corpus in every
    free-text field (nested delimiter forms included), one dataset whose
    identifier payload the generator refused. MUST parse and compile with NO side effect.
  * fixtures/literal-safety-legacy-twin.json — the same project rendered with the pre-fix
    single-pass strip put back. MUST show the payload executing, or this test is blind.

Side-effect oracles (each payload carries markers that never occur literally in the input):
  * `'LSEVAL' ~ 'UATED'` renders to LSEVALUATED — searched in dbt's stdout, logs/dbt.log and every
    file dbt wrote under target/ (manifest.json included);
  * `env_var('LS_CANARY')` — the canary value set in dbt's environment must appear nowhere;
  * `run_query("select 'LSQ' || 'RAN'")` — Trino's own query log (`system.runtime.queries`) must hold
    no query with the marker: dbt must not have sent it.
"""
import glob
import json
import os
import subprocess
import sys
import tempfile

import trino

SRC = os.environ.get("SRC", "/src")
FIX = os.path.join(SRC, "os-ui/tabs/data/lib/dbt/fixtures")
CANARY = "ls-canary-value"
MARKERS = ["LSEVALUATED", CANARY]


def env(home):
    return {
        "PATH": os.environ["PATH"],
        "HOME": home,
        "DBT_SEND_ANONYMOUS_USAGE_STATS": "false",
        "TRINO_HOST": os.environ["TRINO_HOST"],
        "TRINO_PORT": os.environ.get("TRINO_PORT", "8080"),
        "TRINO_USER": "alice",
        "LS_CANARY": CANARY,
    }


def marker_queries():
    """Queries Trino has seen that carry the run_query marker (our own query hides it via chr())."""
    conn = trino.dbapi.connect(host=os.environ["TRINO_HOST"], port=int(os.environ.get("TRINO_PORT", "8080")), user="literal-safety-probe")
    cur = conn.cursor()
    cur.execute("select query from system.runtime.queries where strpos(query, chr(76) || 'SQ') > 0")
    return [r[0] for r in cur.fetchall()]


def run_project(fixture):
    files = json.load(open(fixture))
    root = tempfile.mkdtemp()
    for path, content in files.items():
        full = os.path.join(root, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as fh:
            fh.write(content)
    out, codes = "", []
    for step in ("parse", "compile"):
        p = subprocess.run(["dbt", step, "--profiles-dir", ".", "--target", "local", "--no-use-colors"],
                           cwd=root, env=env(tempfile.mkdtemp()), capture_output=True, text=True, timeout=600)
        codes.append(p.returncode)
        out += p.stdout + p.stderr
        if p.returncode != 0:
            break
    written = out
    for f in glob.glob(os.path.join(root, "target/**/*"), recursive=True) + glob.glob(os.path.join(root, "logs/*")):
        if os.path.isfile(f):
            written += open(f, errors="replace").read()
    seen = sorted({m for m in MARKERS if m in written})
    return codes, seen, out, root


def main():
    failures = []
    before = set(marker_queries())

    codes, seen, out, root = run_project(os.path.join(FIX, "literal-safety-fuzz.golden.json"))
    queries = sorted(set(marker_queries()) - before)
    compiled = glob.glob(os.path.join(root, "target/compiled/**/*.sql"), recursive=True)
    print(f"fuzz project: dbt exit codes {codes}, markers {seen}, marker queries {len(queries)}, compiled {len(compiled)} SQL file(s)")
    if codes != [0, 0]:
        failures.append(f"the fuzz project must parse and compile: exit codes {codes}\n{out[-2500:]}")
    if seen:
        failures.append(f"a payload was EVALUATED by dbt (markers {seen} in dbt output / target/)")
    if queries:
        failures.append(f"dbt sent a payload query to Trino: {queries}")
    if not compiled:
        failures.append("dbt compile wrote no SQL for the fuzz project")
    manifest = os.path.join(root, "target/manifest.json")
    if os.path.exists(manifest) and "\uff5b\uff5b" not in json.dumps(json.load(open(manifest)), ensure_ascii=False):
        failures.append("the encoded free text (fullwidth braces) is missing from manifest.json: the payload fields were not exercised")

    # NEGATIVE TWIN: the pre-fix strip. dbt must visibly execute the payload, else the oracle is blind.
    before = set(marker_queries())
    t_codes, t_seen, t_out, _ = run_project(os.path.join(FIX, "literal-safety-legacy-twin.json"))
    t_queries = sorted(set(marker_queries()) - before)
    print(f"legacy twin:  dbt exit codes {t_codes}, markers {t_seen}, marker queries {len(t_queries)}")
    if not t_seen:
        failures.append(f"NEGATIVE TWIN: no evaluation marker from the legacy-strip project — the output oracle is blind\n{t_out[-1500:]}")
    if not t_queries:
        failures.append("NEGATIVE TWIN: the legacy-strip project sent no marker query — the Trino query-log oracle is blind")

    if failures:
        print("literal-safety: FAIL\n" + "\n".join(failures))
        return 1
    print("literal-safety: ok — no payload evaluated, no env value leaked, no query sent; the twin shows the old strip executing")
    return 0


if __name__ == "__main__":
    sys.exit(main())
