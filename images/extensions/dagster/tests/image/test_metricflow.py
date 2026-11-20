# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""WP-17 (01 M4): the Dagster image carries dbt-core 1.12 and MetricFlow (Apache-2.0, >= 0.213).

Run INSIDE the image under test by run.sh (repo mounted read-only at /src). Nothing is mocked:
every verdict is the image's own `dbt parse` and the image's own `mf validate-configs`.

1. Versions are read from the installed distributions: dbt-core 1.12.x, dagster 1.13.31,
   metricflow >= 0.213 with an Apache-2.0 licence in its own metadata, and the `mf` CLI present.
2. The generator's semantic-layer golden parses on 1.12 and `mf validate-configs --skip-dw`
   accepts the semantic manifest that plain dbt wrote.
3. Negative twin: a metric over a measure that does not exist is refused by dbt itself.
"""
import importlib.metadata as md
import json
import os
import shutil
import subprocess
import tempfile
import unittest

SRC = os.environ.get("SRC", "/src")
APP = os.environ.get("APP_DIR", "/opt/dagster/app")
SEMANTIC = os.path.join(SRC, "os-ui/tabs/data/lib/dbt/fixtures/metrics-semantic-layer.golden.json")
TWIN = os.path.join(SRC, "scripts/tests/glue-fixtures/GLUE-6/dbt/twin-unknown-measure.json")
METRICFLOW_MIN = (0, 213)


def vtuple(v):
    return tuple(int(x) for x in v.split(".")[:3] if x.isdigit())


def write_tree(path, root):
    with open(path) as fh:
        files = json.load(fh)
    for rel, content in files.items():
        full = os.path.join(root, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as fh:
            fh.write(content)


def run(cmd, cwd):
    env = dict(os.environ, DBT_PROFILES_DIR=cwd, OS_PRINCIPAL="ci", TRINO_USER="ci")
    p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=600)
    return p.returncode, p.stdout + p.stderr


class Versions(unittest.TestCase):
    def test_dbt_core_is_1_12(self):
        self.assertEqual(vtuple(md.version("dbt-core"))[:2], (1, 12))
        self.assertEqual(vtuple(md.version("dbt-trino"))[:2], (1, 12))

    def test_dagster_is_1_13_31(self):
        self.assertEqual(md.version("dagster"), "1.13.31")
        self.assertEqual(md.version("dagster-dbt"), "0.29.31")

    def test_metricflow_floor_and_licence_from_its_own_metadata(self):
        self.assertGreaterEqual(vtuple(md.version("metricflow"))[:2], METRICFLOW_MIN)
        meta = md.metadata("metricflow")
        licence = meta.get("License-Expression") or meta.get("License") or ""
        self.assertIn("Apache-2.0", licence)
        self.assertIn("Apache-2.0", md.metadata("dbt-metricflow").get("License-Expression") or "")

    def test_mf_cli_is_on_path(self):
        self.assertIsNotNone(shutil.which("mf"), "dbt-metricflow provides the mf CLI")


class SemanticLayerOnMetricFlow(unittest.TestCase):
    def test_golden_parses_and_mf_validates_the_manifest_dbt_wrote(self):
        with tempfile.TemporaryDirectory() as d:
            write_tree(SEMANTIC, d)
            code, out = run(["python3", os.path.join(APP, "os_projects.py"), "--parse", d], d)
            self.assertEqual(code, 0, out[-2000:])
            with open(os.path.join(d, "target/semantic_manifest.json")) as fh:
                sm = json.load(fh)
            self.assertTrue(sm["semantic_models"] and sm["metrics"], "dbt wrote the semantic manifest")
            code, out = run(["mf", "validate-configs", "--skip-dw"], d)
            self.assertEqual(code, 0, out[-3000:])

    def test_twin_unknown_measure_is_refused_by_dbt(self):
        with tempfile.TemporaryDirectory() as d:
            write_tree(TWIN, d)
            code, out = run(["python3", os.path.join(APP, "os_projects.py"), "--parse", d], d)
            self.assertNotEqual(code, 0, "dbt must refuse a metric over a missing measure")
            self.assertIn("no_such_measure", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
