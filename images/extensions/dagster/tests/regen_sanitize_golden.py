#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Rewrite `sanitize-collisions.golden.json` from `os_projects.sanitize_all`.

The golden is the CONTRACT between the Python code location and the TypeScript OS: both assert
against this one file, so a change to the collision rule fails in CI on whichever side forgot it,
not on the cluster (engine rebuild B3). Run from the repository root:
    python3 images/extensions/dagster/tests/regen_sanitize_golden.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import os_projects as osp  # noqa: E402

INPUTS = ["sales", "sales-eu", "sales.eu", "sales_eu", "finance", "2024", "Ops Team", "ops-team", "ops.team"]
NOTE = (
    "Shared contract: os_projects.sanitize_all (Python) and core/infra/dagster.ts sanitizeAll "
    "(TypeScript) must agree byte for byte. Regenerate with "
    "images/extensions/dagster/tests/regen_sanitize_golden.py."
)

if __name__ == "__main__":
    doc = {"note": NOTE, "inputs": INPUTS, "expected": osp.sanitize_all(INPUTS)}
    with open(os.path.join(HERE, "sanitize-collisions.golden.json"), "w", encoding="utf-8") as fh:
        fh.write(json.dumps(doc, indent=2) + "\n")
    print("wrote sanitize-collisions.golden.json")
