#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Start the chart's OPA exactly as the chart deploys it, in a local container.

Renders templates/base/opa/opa.yaml with `helm template`, writes every ConfigMap the
OPA Deployment mounts to a temp dir, and runs the Deployment's image with the
Deployment's own args and mount paths. Nothing is re-typed here: image, args, files
and paths all come from the rendered chart, so the integration test exercises the
config that ships.

env OPA_IT_DIR (optional): where the rendered files go; must be mountable by docker.
usage: run-chart-opa.py <container-name> <host-port> [extra helm --set ...]
prints: the container name on success.
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
        ["helm", "template", "wp", CHART, "--show-only", "templates/base/opa/opa.yaml", *helm_args],
        check=True, capture_output=True, text=True,
    ).stdout
    docs = [d for d in yaml.safe_load_all(rendered) if d]
    cms = {d["metadata"]["name"]: d for d in docs if d["kind"] == "ConfigMap"}
    dep = next(d for d in docs if d["kind"] == "Deployment" and d["metadata"]["name"] == "opa")
    pod = dep["spec"]["template"]["spec"]
    ctr = next(c for c in pod["containers"] if c["name"] == "opa")
    # OPA_IT_DIR: a parent dir the docker daemon can mount (e.g. under $HOME on colima).
    root = tempfile.mkdtemp(prefix="opa-it-", dir=os.environ.get("OPA_IT_DIR"))
    mounts = []
    volumes = {v["name"]: v for v in pod.get("volumes", [])}
    for vm in ctr.get("volumeMounts", []):
        cm_name = volumes[vm["name"]]["configMap"]["name"]
        host = os.path.join(root, cm_name)
        os.makedirs(host, exist_ok=True)
        for key, val in cms[cm_name]["data"].items():
            with open(os.path.join(host, key), "w", encoding="utf-8") as f:
                f.write(val)
        mounts += ["-v", f"{host}:{vm['mountPath']}:ro"]
    port_arg = next(a for a in ctr["args"] if a.startswith("--addr=")).split(":")[-1]
    subprocess.run(
        ["docker", "run", "-d", "--name", name, "-p", f"127.0.0.1:{port}:{port_arg}", *mounts,
         ctr["image"], *ctr["args"]],
        check=True, stdout=subprocess.DEVNULL,
    )
    print(name)


if __name__ == "__main__":
    main()
