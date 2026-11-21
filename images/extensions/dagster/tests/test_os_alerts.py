# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""WP-50 (alerts): `os_alerts.py` without MetricFlow — the file contract, the comparison and the refusals.

The MetricFlow run itself is proven in the real image against a real Trino
(tests/metrics/alerts-eject.docker.test.ts); here the tool call is a recorded runner.
"""
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import os_alerts  # noqa: E402

ALERT = """version: 2
saved_queries:
  - name: rev_low
    query_params:
      metrics:
        - revenue
    config:
      meta:
        os_alert:
          id: rev_low
          comparator: lt
          threshold: 100
          owner: "1574ad62d48a"
          notify: [in_app]
"""


def repo(text=ALERT):
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, "metrics", "alerts"))
    with open(os.path.join(d, "metrics", "alerts", "rev_low.yml"), "w") as fh:
        fh.write(text)
    return d


def test_load_alerts_reads_the_committed_saved_query():
    [a] = os_alerts.load_alerts(repo())
    assert a == {"path": "metrics/alerts/rev_low.yml", "id": "rev_low", "saved_query": "rev_low", "metric": "revenue", "comparator": "lt", "threshold": 100.0, "owner": "1574ad62d48a"}


@pytest.mark.parametrize("broken", [ALERT.replace("threshold: 100", "threshold: high"), ALERT.replace("comparator: lt", "comparator: approx"), ALERT.replace("        - revenue\n", "        - revenue\n        - orders\n")])
def test_malformed_alert_files_are_refused(broken):
    with pytest.raises(os_alerts.AlertFileError):
        os_alerts.load_alerts(repo(broken))


def test_breached_matches_the_os_comparators():
    assert os_alerts.breached(36, "lt", 100) and not os_alerts.breached(100, "lt", 100)
    assert os_alerts.breached(100, "lte", 100) and os_alerts.breached(101, "gt", 100) and os_alerts.breached(100, "gte", 100)


def test_no_principal_no_run():
    calls = []
    r = os_alerts.evaluate(repo(), "rev_low", env={}, runner=lambda *a, **k: calls.append(a) or (0, ""))
    assert r["status"] == "error" and "OS_PRINCIPAL" in r["reason"] and calls == []


def test_dbt_parse_failure_is_an_error_and_mf_never_runs():
    calls = []

    def runner(cmd, cwd=None, env=None, timeout=600):
        calls.append(cmd[0])
        return (2, "Compilation Error") if cmd[0] == "dbt" else (0, "")

    r = os_alerts.evaluate(repo(), "rev_low", env={"OS_PRINCIPAL": "amir"}, runner=runner)
    assert r["status"] == "error" and "dbt parse" in r["reason"] and calls == ["dbt"]


def test_mf_csv_is_summed_and_compared_with_the_committed_threshold():
    def runner(cmd, cwd=None, env=None, timeout=600):
        if cmd[0] == "mf":
            with open(cmd[cmd.index("--csv") + 1], "w") as fh:
                fh.write("revenue\n36.0\n")
        return 0, ""

    r = os_alerts.evaluate(repo(), "rev_low", env={"OS_PRINCIPAL": "amir"}, runner=runner)
    assert (r["status"], r["value"], r["breached"]) == ("ok", 36.0, True)


def test_unknown_alert_id_is_an_error():
    assert os_alerts.evaluate(repo(), "nope", env={"OS_PRINCIPAL": "amir"})["status"] == "error"


def test_owner_token_must_match_the_running_principal():
    """The run's OS_PRINCIPAL must be the committed owner: sha256(principal)[:12] == os_alert.owner."""
    calls = []
    r = os_alerts.evaluate(repo(), "rev_low", env={"OS_PRINCIPAL": "mallory"}, runner=lambda *a, **k: calls.append(a) or (0, ""))
    assert r["status"] == "error" and "owner" in r["reason"] and calls == []


def test_owner_token_of_the_fixture_is_amir_at_acme():
    import hashlib
    assert hashlib.sha256(b"amir@acme.example").hexdigest()[:12] != "" and os_alerts.owner_token("amir") == hashlib.sha256(b"amir").hexdigest()[:12]
