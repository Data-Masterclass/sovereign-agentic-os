#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""rotation-datastores.py — the files and small computations of rotation round 2 (the datastores).

Used by scripts/ops/rotate-secrets.sh ds-* (docs/ops/WP-secret-rotation.md). Never prints a value:
values reach it on stdin or in files under the private overlays directory (mode 600).

  items <values.json>
      the rotated credentials of this release, one TSV line each:
        <component> <secret> <key> <values path> <role> <database>
      role/database are set for Postgres only. <values.json> is `helm get values --all -o json`
      (the COMPUTED values: the chart defaults merged with the release's), so the extra databases
      are exactly the ones the release renders.
  build <values.json> <overlay> <components,…>
      writes, mode 600 and never over an existing file:
        <overlay>                 the new values (random, hex) for the named components;
        <overlay>.rollback.yaml   the current values, to go back;
      and prints `<secret>/<key> <sha256 prefix of the new value>` per item. Postgres lists
      (postgres.extraDatabases) are written WHOLE: Helm replaces a list, it never merges one.
  get <overlay|values.json> <values path>
      the value at the path (`postgres.extraDatabases[litellm].localPassword` selects by name);
      empty when absent. For a shell variable only.
  scram (stdin: the password)
      a PostgreSQL SCRAM-SHA-256 verifier (RFC 7677, 4096 iterations, random salt) — what
      `ALTER ROLE … PASSWORD '<verifier>'` stores as-is, so the clear password never reaches the
      server (nor its statement log).
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sys

import yaml

COMPONENTS = ("postgres", "clickhouse", "valkey", "minio", "litellm-master", "agent-key")


def load(path):
    with open(path) as f:
        return json.load(f) if path.endswith(".json") else (yaml.safe_load(f) or {})


def get(tree, path):
    node = tree
    for part in path.split("."):
        m = re.fullmatch(r"(\w+)\[([\w-]+)\]", part)
        if m:
            node = (node or {}).get(m.group(1)) if isinstance(node, dict) else None
            node = next((e for e in node or [] if isinstance(e, dict) and e.get("name") == m.group(2)), None)
        else:
            node = node.get(part) if isinstance(node, dict) else None
        if node is None:
            return None
    return node


def items(values):
    out = []
    pg = values.get("postgres") or {}
    if pg.get("enabled") and pg.get("engine", "plain") == "plain":
        out.append(("postgres", pg["secretName"], "password", "postgres.local.password", pg["username"], pg["database"]))
        for e in pg.get("extraDatabases") or []:
            out.append(("postgres", e["secretName"], "password", f"postgres.extraDatabases[{e['name']}].localPassword", e["username"], e["name"]))
    ch = values.get("clickhouse") or {}
    if ch.get("enabled"):
        out.append(("clickhouse", ch["secretName"], "password", "clickhouse.local.password", "", ""))
    vk = values.get("valkey") or {}
    if vk.get("enabled"):
        out.append(("valkey", vk["secretName"], "password", "valkey.local.password", "", ""))
    os_ = values.get("objectStorage") or {}
    if os_.get("enabled") and os_.get("mode", "bundled") == "bundled":
        out.append(("minio", os_["secretName"], "AWS_SECRET_ACCESS_KEY", "objectStorage.local.secretKey", "", ""))
    ll = values.get("litellm") or {}
    if ll.get("enabled", True) and values.get("litellmMasterKey") is not None:
        out.append(("litellm-master", ll.get("masterkeySecretName") or "litellm-credentials", ll.get("masterkeySecretKey") or "masterkey", "litellmMasterKey", "", ""))
    ak = values.get("litellmAgentKey") or {}
    if ak.get("enabled"):
        out.append(("agent-key", ak["secretName"], "apiKey", "litellmAgentKey.local.value", "", ""))
    return out


def new_value(component):
    if component == "litellm-master":
        return "sk-" + secrets.token_hex(32)
    if component == "agent-key":
        return "sk-" + secrets.token_hex(24)          # LiteLLM keys start with sk-
    if component == "minio":
        return secrets.token_hex(20)                  # MinIO: 8..40 characters
    return secrets.token_hex(32)


def write600(path, title, tree):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(f"# {title} — PRIVATE, never commit. Run-book: docs/ops/WP-secret-rotation.md\n")
        yaml.safe_dump(tree, f, sort_keys=True)


def set_path(tree, path, value):
    parts = path.split(".")
    node = tree
    for p in parts[:-1]:
        node = node.setdefault(p, {})
    node[parts[-1]] = value


def build(values, overlay, comps):
    unknown = set(comps) - set(COMPONENTS)
    if unknown:
        sys.exit(f"unknown component(s): {', '.join(sorted(unknown))} (known: {', '.join(COMPONENTS)})")
    new, old = {}, {}
    pg_list_new = pg_list_old = None
    for comp, secret, key, path, _role, _db in items(values):
        if comp not in comps:
            continue
        value = new_value(comp)
        m = re.fullmatch(r"postgres\.extraDatabases\[([\w-]+)\]\.localPassword", path)
        if m:
            if pg_list_new is None:
                pg_list_old = json.loads(json.dumps(values["postgres"]["extraDatabases"]))
                pg_list_new = json.loads(json.dumps(pg_list_old))
            for e in pg_list_new:
                if e["name"] == m.group(1):
                    e["localPassword"] = value
        else:
            set_path(new, path, value)
            set_path(old, path, get(values, path))
        print(f"{secret}/{key} {hashlib.sha256(value.encode()).hexdigest()[:16]}")
    if pg_list_new is not None:
        set_path(new, "postgres.extraDatabases", pg_list_new)
        set_path(old, "postgres.extraDatabases", pg_list_old)
    if not new:
        sys.exit("nothing to rotate for: " + ",".join(comps))
    write600(overlay, "rotation round 2: new datastore credentials", new)
    write600(overlay[:-5] + ".rollback.yaml", "rotation round 2: the previous datastore credentials", old)


def scram(password, iterations=4096):
    salt = secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    b64 = lambda b: base64.b64encode(b).decode()
    return f"SCRAM-SHA-256${iterations}:{b64(salt)}${b64(stored_key)}:{b64(server_key)}"


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "items":
        for row in items(load(argv[2])):
            print("\t".join(row))
    elif cmd == "build":
        build(load(argv[2]), argv[3], [c for c in argv[4].split(",") if c])
    elif cmd == "get":
        v = get(load(argv[2]), argv[3])
        if v is not None:
            sys.stdout.write(str(v))
    elif cmd == "scram":
        pw = sys.stdin.read().rstrip("\n")
        if not pw:
            sys.exit("empty password")
        print(scram(pw))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
