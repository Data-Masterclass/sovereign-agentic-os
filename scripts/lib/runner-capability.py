#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""runner-capability.py <manifest.yaml|-> — does the data-runner in this rendered manifest apply
os-ui's `columnNames`? Prints `true`, `false` or `absent` (no data-runner Deployment).

FAIL CLOSED: an unreadable input, a missing PyYAML or a manifest that does not parse exits 2 —
callers (scripts/rollback.sh, scripts/deploy.sh) refuse on that, they never treat it as `false`.
"""
import sys

try:
    import yaml
except Exception as e:  # noqa: BLE001
    print(f"runner-capability: PyYAML is not available ({e})", file=sys.stderr)
    sys.exit(2)

try:
    text = sys.stdin.read() if sys.argv[1:] in ([], ["-"]) else open(sys.argv[1]).read()
    docs = list(yaml.safe_load_all(text))
except Exception as e:  # noqa: BLE001
    print(f"runner-capability: cannot read the manifest ({e})", file=sys.stderr)
    sys.exit(2)

value = "absent"
for d in docs:
    if isinstance(d, dict) and d.get("kind") == "Deployment" and (d.get("metadata") or {}).get("name") == "data-runner":
        ann = (d["metadata"].get("annotations") or {}).get("sovereign-os/applies-column-names", "")
        value = "true" if str(ann).lower() == "true" else "false"
print(value)
