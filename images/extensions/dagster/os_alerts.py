# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""WP-50 (alerts): evaluate a domain's committed metric alerts with MetricFlow.

FEATURE:    An alert rule committed as `metrics/alerts/<name>.yml` (a dbt saved query with the
            threshold in `config.meta.os_alert`, written by os-ui `tabs/metrics/lib/git/alerts-native.ts`)
            is evaluated by running that saved query with MetricFlow's own CLI,
            `mf query --saved-query <name> --csv <file>` (dbt-metricflow), in the domain's dbt project,
            and comparing MetricFlow's number with the committed threshold.
USER STORY: As an alert owner I want the number my alert tests to be the one MetricFlow returns for the
            committed saved query, the same query anyone can run on the repo with no OS present.
ARCHITECTURE:
  - No SQL is built here: MetricFlow compiles and runs the query; this module reads its CSV.
  - `mf` reads `target/semantic_manifest.json`, so `dbt parse` runs first on the checkout: the
    saved query MetricFlow runs is always the committed one, never a stale artifact.
  - Identity: `mf` connects through the dbt profile, which impersonates `OS_PRINCIPAL`; the caller
    (the Dagster run, tagged with the alert owner as its principal) sets it. No principal, no run;
    a principal whose token is not the committed `os_alert.owner`, no run.
  - The value is the sum of the metric column over MetricFlow's rows (one row for an alert, which has
    no group-by), the same reduction os-ui's evaluator applies.
  - Never raises from `evaluate`: a refusal is `{"status": "error", ...}` with MetricFlow's output.
CLI:  python3 os_alerts.py evaluate --repo <checkout> --alert <os_alert.id>
"""
from __future__ import annotations

import argparse
import csv
import glob
import hashlib
import json
import os
import sys
import tempfile
from typing import Dict, List, Mapping, Optional

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import os_projects as osp  # noqa: E402

ALERTS_DIR = os.path.join("metrics", "alerts")
COMPARATORS = ("lt", "lte", "gt", "gte")


class AlertFileError(ValueError):
    pass


def load_alerts(repo_dir: str) -> List[Dict[str, object]]:
    """Every committed alert of a checkout, sorted by file. A malformed file is an AlertFileError."""
    out: List[Dict[str, object]] = []
    for path in sorted(glob.glob(os.path.join(repo_dir, ALERTS_DIR, "*.yml"))):
        rel = os.path.relpath(path, repo_dir)
        with open(path, encoding="utf-8") as fh:
            doc = yaml.safe_load(fh) or {}
        saved = doc.get("saved_queries") if isinstance(doc, dict) else None
        if not isinstance(saved, list) or len(saved) != 1 or not isinstance(saved[0], dict):
            raise AlertFileError(f"{rel}: an alert file holds exactly one saved query")
        sq = saved[0]
        metrics = (sq.get("query_params") or {}).get("metrics") or []
        meta = ((sq.get("config") or {}).get("meta") or {}).get("os_alert") or {}
        if len(metrics) != 1 or not isinstance(metrics[0], str):
            raise AlertFileError(f"{rel}: an alert watches exactly one metric")
        if meta.get("comparator") not in COMPARATORS:
            raise AlertFileError(f"{rel}: os_alert.comparator must be one of {', '.join(COMPARATORS)}")
        thr = meta.get("threshold")
        if isinstance(thr, bool) or not isinstance(thr, (int, float)):
            raise AlertFileError(f"{rel}: os_alert.threshold must be a number")
        if not sq.get("name") or not meta.get("id"):
            raise AlertFileError(f"{rel}: name and os_alert.id are required")
        out.append({"path": rel, "id": str(meta["id"]), "saved_query": str(sq["name"]), "metric": metrics[0],
                    "comparator": meta["comparator"], "threshold": float(thr), "owner": str(meta.get("owner") or "")})
    return out


def owner_token(principal: str) -> str:
    """The opaque repository token os-ui writes for an owner: sha256(principal)[:12]."""
    return hashlib.sha256(principal.encode("utf-8")).hexdigest()[:12]


def breached(value: float, comparator: str, threshold: float) -> bool:
    return {"lt": value < threshold, "lte": value <= threshold, "gt": value > threshold, "gte": value >= threshold}[comparator]


def mf_value(dbt_project: str, saved_query: str, metric: str, env: Optional[Mapping[str, str]] = None, runner: osp.Runner = osp._run) -> Dict[str, object]:
    """Run the saved query with MetricFlow's CLI; the metric column summed over its rows."""
    with tempfile.TemporaryDirectory(prefix="os-alert-") as tmp:
        out = os.path.join(tmp, "result.csv")
        rc, output = runner(["mf", "query", "--saved-query", saved_query, "--csv", out], cwd=dbt_project, env=env)
        if rc != 0 or not os.path.isfile(out):
            return {"status": "error", "reason": f"mf query --saved-query {saved_query} exited {rc}", "output": output[-2000:]}
        with open(out, newline="", encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))
    if not rows:
        return {"status": "pending", "reason": "MetricFlow returned no rows"}
    if metric not in rows[0]:
        return {"status": "error", "reason": f"MetricFlow's result has no column {metric!r}", "output": ",".join(rows[0].keys())}
    return {"status": "ok", "value": sum(float(r[metric] or 0) for r in rows)}


def evaluate(repo_dir: str, alert_id: str, env: Optional[Mapping[str, str]] = None, runner: osp.Runner = osp._run) -> Dict[str, object]:
    """Evaluate one committed alert of a checkout. Never raises."""
    try:
        alerts = [a for a in load_alerts(repo_dir) if a["id"] == alert_id]
    except (AlertFileError, yaml.YAMLError) as e:
        return {"id": alert_id, "status": "error", "reason": str(e)}
    if not alerts:
        return {"id": alert_id, "status": "error", "reason": f"no committed alert {alert_id!r} under {ALERTS_DIR}/"}
    a = alerts[0]
    principal = (env if env is not None else os.environ).get("OS_PRINCIPAL", "")
    if not principal:
        return {**a, "status": "error", "reason": "OS_PRINCIPAL is not set: MetricFlow would not run as the alert's owner"}
    if owner_token(principal) != a["owner"]:
        return {**a, "status": "error", "reason": "the run's principal is not the committed owner of this alert (os_alert.owner): refused"}
    project = osp.dbt_dir(repo_dir)
    rc, output = runner(["dbt", "parse", "--no-partial-parse"], cwd=project, env=env)
    if rc != 0:
        return {**a, "status": "error", "reason": f"dbt parse exited {rc}: the committed project does not parse", "output": output[-2000:]}
    r = mf_value(project, str(a["saved_query"]), str(a["metric"]), env=env, runner=runner)
    if r["status"] != "ok":
        return {**a, **r}
    value = float(r["value"])  # type: ignore[arg-type]
    return {**a, "status": "ok", "value": value, "breached": breached(value, str(a["comparator"]), float(a["threshold"]))}  # type: ignore[arg-type]


def _main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(prog="os_alerts.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    ev = sub.add_parser("evaluate")
    ev.add_argument("--repo", required=True)
    ev.add_argument("--alert", required=True)
    args = ap.parse_args(argv)
    res = evaluate(args.repo, args.alert)
    print(json.dumps(res, sort_keys=True))
    return 0 if res.get("status") == "ok" else 1


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
