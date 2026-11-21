#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""rotation-drift-guard.py — refuse a deploy or rollback that would undo a rotation in progress.

  rotation-drift-guard.py --what <deploy|rollback> <render.yaml>

`rotate-secrets.sh ds-rekey` (docs/ops/WP-secret-rotation.md) writes Secret keys in the cluster
BEFORE the overlay deploy, with the field manager `rotate-secrets`. Until the overlay is deployed
the release still renders the older values, so a deploy or a rollback from them puts the old
credential back — while the database already has the new one — and silently undoes the rotation.

For every Secret key that the cluster records as managed by `rotate-secrets` (managedFields), the
value in <render.yaml> (what this deploy/rollback applies) is compared with the cluster's, by
sha256. A difference REFUSES (exit 1), naming the key, both fingerprints and the private overlay
whose value is the cluster's (under $SOVEREIGN_SECRETS_DIR/overlays, default
~/.sovereign-os-secrets/overlays). ROTATION_IN_PROGRESS=<anything> turns the refusal into a warning.

Not compared: keys `rotate-secrets` does not manage, and Secrets the render does not carry (this
deploy cannot overwrite them). FAIL CLOSED: the Secrets cannot be read (kubectl fails or answers
nothing) → exit 2. READ-ONLY: `$KUBECTL get secrets -o json` (KUBECTL: the full kubectl prefix,
context and namespace included). Never prints a value: names and sha256 prefixes only.
"""
import base64
import glob
import hashlib
import json
import os
import shlex
import subprocess
import sys

import yaml

MANAGER = "rotate-secrets"


def fp(value):
    return hashlib.sha256(value.encode()).hexdigest()[:12]


def rendered_secrets(path):
    out = {}
    for d in yaml.safe_load_all(open(path)):
        if not isinstance(d, dict) or d.get("kind") != "Secret" or not (d.get("metadata") or {}).get("name"):
            continue
        data = {k: base64.b64decode(v).decode("utf-8", "replace") for k, v in (d.get("data") or {}).items()}
        data.update({k: str(v) for k, v in (d.get("stringData") or {}).items()})
        out[d["metadata"]["name"]] = data
    return out


def live_secrets():
    kubectl = shlex.split(os.environ.get("KUBECTL", "kubectl"))
    try:
        r = subprocess.run(kubectl + ["get", "secrets", "-o", "json"], capture_output=True, text=True)
    except OSError as e:
        sys.exit(f"ROTATION_DRIFT_UNKNOWN — cannot read the Secrets ({e}). Refusing rather than guessing.")
    if r.returncode != 0 or not r.stdout.strip():
        print(f"ROTATION_DRIFT_UNKNOWN — cannot read the Secrets (kubectl exited {r.returncode}"
              f"{', no output' if not r.stdout.strip() else ''}). Refusing rather than guessing.", file=sys.stderr)
        sys.exit(2)
    try:
        return json.loads(r.stdout).get("items") or []
    except ValueError:
        print("ROTATION_DRIFT_UNKNOWN — cannot read the Secrets (kubectl answered no JSON). Refusing.", file=sys.stderr)
        sys.exit(2)


def managed_keys(secret):
    keys = set()
    for m in (secret.get("metadata") or {}).get("managedFields") or []:
        if m.get("manager") != MANAGER:
            continue
        for section in ("f:data", "f:stringData"):
            for k in ((m.get("fieldsV1") or {}).get(section) or {}):
                if k.startswith("f:"):
                    keys.add(k[2:])
    return keys


def overlay_for(secret, key, live_fp, overlays_dir):
    """The round-2 overlay whose value for <secret>/<key> is the cluster's (newest first)."""
    for state in sorted(glob.glob(os.path.join(overlays_dir, "*.state.json")), reverse=True):
        try:
            st = json.load(open(state))
        except (OSError, ValueError):
            continue
        overlay = state[: -len(".state.json")] + ".yaml"
        if not os.path.exists(overlay):
            continue
        for row in st.get("items") or []:
            if len(row) >= 4 and row[1] == secret and row[2] == key:
                value = lookup(yaml.safe_load(open(overlay)) or {}, row[3])
                if value is not None and fp(str(value)) == live_fp:
                    return overlay
    return None


def lookup(tree, path):
    node = tree
    for part in path.split("."):
        if "[" in part and part.endswith("]"):
            name, sel = part[:-1].split("[", 1)
            node = (node or {}).get(name) if isinstance(node, dict) else None
            node = next((e for e in node or [] if isinstance(e, dict) and e.get("name") == sel), None)
        else:
            node = node.get(part) if isinstance(node, dict) else None
        if node is None:
            return None
    return node


def main(argv):
    what, path = "deploy", None
    args = argv[1:]
    while args:
        a = args.pop(0)
        if a == "--what":
            what = args.pop(0)
        else:
            path = a
    if not path:
        sys.exit(__doc__)
    overlays_dir = os.path.join(os.environ.get("SOVEREIGN_SECRETS_DIR") or os.path.expanduser("~/.sovereign-os-secrets"), "overlays")
    render = rendered_secrets(path)
    drift, compared = [], 0
    for s in live_secrets():
        name = (s.get("metadata") or {}).get("name")
        keys = managed_keys(s)
        if not keys:
            continue
        data = {k: base64.b64decode(v).decode("utf-8", "replace") for k, v in (s.get("data") or {}).items()}
        for key in sorted(keys):
            if name not in render or key not in render[name]:
                print(f"   note {name}/{key}: not in the render — this {what} cannot overwrite it")
                continue
            compared += 1
            live, new = fp(data.get(key, "")), fp(render[name][key])
            if live != new:
                drift.append((name, key, live, new))
    if not drift:
        print(f"   ok   {compared} key(s) managed by rotate-secrets: the render carries the cluster's value")
        return 0
    lines = []
    for name, key, live, new in drift:
        ov = overlay_for(name, key, live, overlays_dir)
        lines.append(f"     {name}/{key}: cluster {live}…, this {what} would apply {new}… — "
                     + (f"deploy with VALUES_OVERLAY={ov}" if ov else f"no overlay under {overlays_dir} holds the cluster's value"))
    if os.environ.get("ROTATION_IN_PROGRESS"):
        print(f"   WARNING ROTATION_IN_PROGRESS is set: this {what} replaces {len(drift)} key(s) rotate-secrets.sh wrote:")
        print("\n".join(lines))
        return 0
    print(f"ROTATION_DRIFT_REFUSED — this {what} would put OLDER values back into {len(drift)} Secret key(s) that "
          "rotate-secrets.sh ds-rekey already changed in the cluster (the databases have the new ones): "
          "it would silently undo the rotation.", file=sys.stderr)
    print("\n".join(lines), file=sys.stderr)
    print("   Deploy the round-2 overlay (docs/ops/WP-secret-rotation.md, run-book step 4), or roll the rotation back "
          "with ds-rekey --rollback first. Only if you know why, set ROTATION_IN_PROGRESS=1. Nothing was changed.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
