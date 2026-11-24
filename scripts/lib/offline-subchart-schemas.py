#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Make the fetched subcharts' values schemas validate offline.

The Dagster chart (1.13.11) and its dagster-user-deployments subchart point 40 `$ref`s at
  https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/v1.19.0/_definitions.json
so EVERY `helm template` / `helm lint` of our chart downloads that file to validate values. When
raw.githubusercontent.com answers 503 the render fails ("Could not read schema from HTTP, response
status is 503") and the CI job goes red for a reason that has nothing to do with the change (CI,
23 Nov 2026: test-observability).

This keeps the validation and makes it deterministic: the definitions those refs reach (their
transitive closure, vendored in scripts/lib/k8s-definitions-v1.19.0.json from the same upstream
file, Apache-2.0) are put into each schema under `definitions`, and each remote ref becomes the
local `#/definitions/...`. The schema validates the same values the same way; it just no longer
needs the network. A ref to anything else, a definition missing from the vendored set, or an
existing `definitions` key fails loudly — never a silently weakened schema.

  offline-subchart-schemas.py [charts/sovereign-agentic-os]   (run after `helm dependency build`)
"""
import io
import json
import os
import re
import sys
import tarfile

REMOTE = "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/v1.19.0/_definitions.json"
HERE = os.path.dirname(os.path.abspath(__file__))
VENDORED = os.path.join(HERE, "k8s-definitions-v1.19.0.json")


def closure(defs, schema_text):
    root = lambda k: k.split("/")[0]  # noqa: E731 — "X/properties/y" is a pointer into X
    todo = [root(k) for k in re.findall(re.escape(REMOTE) + r'#/definitions/([^"]+)"', schema_text)]
    seen = set()
    while todo:
        k = todo.pop()
        if k in seen:
            continue
        if k not in defs:
            raise SystemExit(f"offline-subchart-schemas: definition {k!r} is not in {VENDORED} — regenerate it (see --vendor)")
        seen.add(k)
        todo += [root(r) for r in re.findall(r'"#/definitions/([^"]+)"', json.dumps(defs[k]))]
    return {k: defs[k] for k in sorted(seen)}


def rewrite(schema_text, defs):
    if "raw.githubusercontent.com" in schema_text.replace(REMOTE, ""):
        raise SystemExit("offline-subchart-schemas: a schema references another remote document — extend this script")
    schema = json.loads(schema_text)
    if "definitions" in schema:
        raise SystemExit("offline-subchart-schemas: the schema already has `definitions` — merge rules needed")
    schema = json.loads(schema_text.replace(REMOTE + "#", "#"))
    schema["definitions"] = closure(defs, schema_text)
    return json.dumps(schema, indent=2).encode()


def patch_tgz(path, defs):
    with tarfile.open(path, "r:gz") as tf:
        members = [(m, tf.extractfile(m).read() if m.isfile() else None) for m in tf.getmembers()]
    changed = 0
    out = []
    for m, data in members:
        if data is not None and m.name.endswith("values.schema.json") and REMOTE.encode() in data:
            data = rewrite(data.decode(), defs)
            m.size = len(data)
            changed += 1
        out.append((m, data))
    if not changed:
        return 0
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for m, data in out:
            tf.addfile(m, io.BytesIO(data) if data is not None else None)
    with open(path, "wb") as f:
        f.write(buf.getvalue())
    return changed


def vendor(upstream_json, chart_tgz):
    """Regenerate the vendored closure: --vendor <downloaded _definitions.json> <dagster-x.y.z.tgz>."""
    defs = json.load(open(upstream_json))["definitions"]
    with tarfile.open(chart_tgz, "r:gz") as tf:
        text = "".join(tf.extractfile(m).read().decode() for m in tf.getmembers() if m.isfile() and m.name.endswith("values.schema.json"))
    out = {"$comment": f"Transitive closure of the definitions the Dagster chart's values schemas reference in {REMOTE} "
                       "(yannh/kubernetes-json-schema, Apache-2.0). Regenerate: scripts/lib/offline-subchart-schemas.py --vendor <file> <tgz>.",
           "definitions": closure(defs, text)}
    with open(VENDORED, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)
        f.write("\n")
    print(f"vendored {len(out['definitions'])} definitions → {VENDORED}")


def main(argv):
    if argv[:1] == ["--vendor"]:
        return vendor(argv[1], argv[2])
    chart = argv[0] if argv else "charts/sovereign-agentic-os"
    defs = json.load(open(VENDORED))["definitions"]
    sub = os.path.join(chart, "charts")
    total = 0
    for name in sorted(os.listdir(sub)) if os.path.isdir(sub) else []:
        if name.endswith(".tgz"):
            n = patch_tgz(os.path.join(sub, name), defs)
            if n:
                print(f"offline-subchart-schemas: {name}: {n} values schema(s) now validate without the network")
            total += n
    if total == 0:
        print("offline-subchart-schemas: no subchart schema references the remote definitions (nothing to do)")


if __name__ == "__main__":
    main(sys.argv[1:])
