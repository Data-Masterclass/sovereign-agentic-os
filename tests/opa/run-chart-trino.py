#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Start the chart's Trino (image, config, OPA access control, access rules) in a container.

Renders templates/extensions/lakehouse/trino.yaml with `helm template` and mounts every file the
Trino Deployment mounts under /etc/trino, at its own path. ONE deliberate substitution: the
`iceberg` catalog is Trino's `memory` connector under the same catalog name, so tables named
`iceberg.<schema>.<table>` exist without Polaris and object storage. The access control under test
(Trino's OPA plugin, `access-control-opa.properties`, and the file rules) is the chart's, unchanged.

usage: run-chart-trino.py <container-name> <host-port> [extra helm --set ...]
"""
import os
import subprocess
import sys
import tempfile

import yaml

CHART = os.path.join(os.path.dirname(__file__), "..", "..", "charts", "sovereign-agentic-os")


def main() -> None:
    name, port, *helm_args = sys.argv[1:]
    rendered = subprocess.run(
        ["helm", "template", "wp", CHART, "--show-only", "templates/extensions/lakehouse/trino.yaml", *helm_args],
        check=True, capture_output=True, text=True,
    ).stdout
    docs = [d for d in yaml.safe_load_all(rendered) if d]
    cms = {d["metadata"]["name"]: d for d in docs if d["kind"] == "ConfigMap"}
    dep = next(d for d in docs if d["kind"] == "Deployment" and d["metadata"]["name"] == "trino")
    pod = dep["spec"]["template"]["spec"]
    ctr = next(c for c in pod["containers"] if c["name"] == "trino")
    volumes = {v["name"]: v for v in pod.get("volumes", [])}
    root = tempfile.mkdtemp(prefix="trino-it-", dir=os.environ.get("OPA_IT_DIR"))
    mounts = []
    for vm in ctr.get("volumeMounts", []):
        path = vm["mountPath"]
        if not path.startswith("/etc/trino"):
            continue
        vol = volumes[vm["name"]]
        if "configMap" not in vol:
            continue
        data = dict(cms[vol["configMap"]["name"]]["data"])
        if vol["configMap"]["name"] == "trino-catalog":
            data = {"iceberg.properties": "connector.name=memory\n"}
        host = os.path.join(root, vm["name"])
        os.makedirs(host, exist_ok=True)
        if "subPath" in vm:
            with open(os.path.join(host, vm["subPath"]), "w", encoding="utf-8") as f:
                f.write(data[vm["subPath"]])
            mounts += ["-v", f"{os.path.join(host, vm['subPath'])}:{path}:ro"]
        else:
            for key, val in data.items():
                with open(os.path.join(host, key), "w", encoding="utf-8") as f:
                    f.write(val)
            mounts += ["-v", f"{host}:{path}:ro"]
    subprocess.run(
        ["docker", "run", "-d", "--name", name, "-p", f"127.0.0.1:{port}:8080",
         "--add-host=host.docker.internal:host-gateway", *mounts, ctr["image"]],
        check=True, stdout=subprocess.DEVNULL,
    )
    print(name)


if __name__ == "__main__":
    main()
