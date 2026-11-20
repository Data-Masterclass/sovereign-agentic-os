#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""manifest-diff.py — what an upgrade changes, object by object, without showing a value.

  python3 scripts/lib/manifest-diff.py <before.yaml> <after.yaml>

<before> is `helm get manifest` of the live release, <after> the chart rendered with the values the
upgrade applies. Prints every object that is added, removed or changed (kind/name), for a Secret
the KEYS whose value changes (compared by sha256), and for a workload whether its pod template
changed — i.e. whether the upgrade rolls it by itself. A Secret change alone restarts nothing.
Exit 0 always; it is information for the operator (scripts/ops/rotate-secrets.sh plan).
"""
import base64
import hashlib
import json
import sys

import yaml

WORKLOADS = {'Deployment', 'StatefulSet', 'DaemonSet'}


def load(path):
    out = {}
    with open(path) as f:
        for d in yaml.safe_load_all(f):
            if isinstance(d, dict) and d.get('kind') and (d.get('metadata') or {}).get('name'):
                out[(d['kind'], d['metadata']['name'])] = d
    return out


def h(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()


def secret_values(d):
    vals = {k: base64.b64decode(v).decode('utf-8', 'replace') for k, v in (d.get('data') or {}).items()}
    vals.update({k: str(v) for k, v in (d.get('stringData') or {}).items()})
    return {k: hashlib.sha256(v.encode()).hexdigest() for k, v in vals.items()}


def strip(d):
    d = json.loads(json.dumps(d, default=str))
    md = d.get('metadata') or {}
    for k in ('labels', 'annotations'):
        md.pop(k, None)   # chart version labels move on every release; reported separately below
    return d


def main(before, after):
    a, b = load(before), load(after)
    added, removed = sorted(set(b) - set(a)), sorted(set(a) - set(b))
    changed, rolls, labels_only = [], [], []
    for key in sorted(set(a) & set(b)):
        x, y = a[key], b[key]
        if h(x) == h(y):
            continue
        if key[0] == 'Secret':
            sx, sy = secret_values(x), secret_values(y)
            keys = sorted(k for k in set(sx) | set(sy) if sx.get(k) != sy.get(k))
            rest = h({**strip(x), 'data': None, 'stringData': None}) != h({**strip(y), 'data': None, 'stringData': None})
            if keys or rest:
                changed.append(f"Secret {key[1]}: keys {', '.join(keys) or '-'}{' (+ metadata/type)' if rest else ''}")
            else:
                labels_only.append(f'{key[0]}/{key[1]}')
            continue
        if h(strip(x)) == h(strip(y)):
            labels_only.append(f'{key[0]}/{key[1]}')
            continue
        changed.append(f'{key[0]} {key[1]}')
        if key[0] in WORKLOADS and h(x['spec'].get('template')) != h(y['spec'].get('template')):
            rolls.append(f'{key[0]}/{key[1]}')
    print(f'   objects: {len(a)} live, {len(b)} rendered')
    for k, n in added:
        print(f'   add     {k} {n}')
    for k, n in removed:
        print(f'   delete  {k} {n}')
    for line in changed:
        print(f'   change  {line}')
    if labels_only:
        print(f'   labels/annotations only: {len(labels_only)} objects ({", ".join(labels_only[:6])}{" …" if len(labels_only) > 6 else ""})')
    print(f'   rolls by itself (pod template changed): {", ".join(rolls) or "nothing"}')
    print('   every other reader of a changed Secret keeps the old value until it is restarted')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
