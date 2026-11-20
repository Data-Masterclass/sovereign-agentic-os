#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Print one env value of the os-ui container exactly as the chart renders it.

usage: chart-env.py <ENV_NAME> [extra helm --set ...]
The bundle tests take os-ui's OS_OPA_SEED from here, so the seed they compile is the chart's own.
"""
import os
import subprocess
import sys

import yaml

CHART = os.path.join(os.path.dirname(__file__), "..", "..", "charts", "sovereign-agentic-os")

name, *helm_args = sys.argv[1:]
out = subprocess.run(
    ["helm", "template", "wp", CHART, "--show-only", "templates/base/os-ui/os-ui.yaml", *helm_args],
    check=True, capture_output=True, text=True,
).stdout
for doc in yaml.safe_load_all(out):
    if not doc or doc.get("kind") != "Deployment":
        continue
    for c in doc["spec"]["template"]["spec"]["containers"]:
        for e in c.get("env", []):
            if e["name"] == name and "value" in e:
                sys.stdout.write(e["value"])
                sys.exit(0)
sys.exit(f"chart-env.py: {name} not rendered")
