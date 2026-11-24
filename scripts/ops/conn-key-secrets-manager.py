#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""conn-key-secrets-manager.py — put the connection-credential key into STACKIT Secrets Manager.

Connection credentials are sealed under a data key that a key provider wraps (os-ui
core/infra/key-manager.ts). For the `eso` provider (GitOps installs) the MASTER key — the Secret
`os-secrets-encryption-key` (OS_SECRETS_ENCRYPTION_KEY) — is written by ESO from STACKIT Secrets
Manager (externalSecrets.managed). This script is the owner's one-off tool for that vault side.
Installs using the builtin provider + recovery key, or STACKIT KMS, do not need it. Runbook:
docs/ops/connection-keys.md (GitOps / ESO).

  create   generate a NEW key locally and write it to Secrets Manager. Refuses when the remote key
           already exists (and writes with cas=0, so a concurrent writer cannot be overwritten).
           For a cluster that has never stored a credential. On a cluster that HAS, use migrate:
           a new master key cannot unwrap the existing data key (the store would be LOCKED until
           someone enters the recovery key).
  migrate  copy the LIVE key (the chart-generated cluster Secret) into Secrets Manager, then read it
           back and compare fingerprints. Absent remotely → written (cas=0); present with the same
           fingerprint → nothing to do; present with ANOTHER fingerprint → refused.
           --previous-secret <name> also copies a live rotation Secret (OS_SECRETS_ENCRYPTION_KEY_PREVIOUS).
  verify   fingerprint of the live key vs the Secrets Manager copy (exit 1 when they differ).
  rotate   stage a MASTER-key rotation in Secrets Manager: previous := current[,older previous], then
           current := a NEW key (both with cas on the version read). Then follow the runbook
           (force-sync both ExternalSecrets, restart os-ui + os-ui-worker): the key manager unwraps
           with the retired key and re-wraps every data key under the new one by itself.

  Common options:
    --instance-id <id>       the Secrets Manager instance ID (the KV v2 mount)          [required]
    --prefix <p>             remote key = <p>/os-secrets-encryption-key (default: --namespace)
    --remote-key <path>      the remote key itself (= externalSecrets.remoteKeys.os-secrets-encryption-key)
    --previous-remote-key <path>  default <prefix>/os-secrets-encryption-key-previous
    --context <ctx> --namespace <ns>   the cluster (migrate/verify; default dmagenticos / agentic-os)
    --dry-run                reads only; prints what would be written

  Token: $SM_HEADER names a file holding `X-Vault-Token: <token>` (writer token for create /
  migrate / rotate; the reader suffices for verify) — mode 600, as in
  docs/ops/external-secrets-migration.md. $SM_URL overrides https://prod.sm.eu01.stackit.cloud.

NEVER PRINTS A KEY. Values travel to curl on stdin and back through a mode-700 temp directory that
is deleted on exit; only `sha256:<first 16 hex>` fingerprints are printed. Exit 0 done, 1 refused /
mismatch / error, 2 usage.
"""
import argparse
import hashlib
import json
import os
import secrets
import shutil
import stat
import string
import subprocess
import sys
import tempfile

KEY_SECRET = "os-secrets-encryption-key"
PREV_SECRET = "os-secrets-encryption-key-previous"
KEY = "OS_SECRETS_ENCRYPTION_KEY"
PREV = "OS_SECRETS_ENCRYPTION_KEY_PREVIOUS"
MIN_LEN = 32  # os-ui/core/infra/secret-crypto.ts MIN_SECRET_LENGTH


class Refused(Exception):
    pass


def fp(value):
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()[:16]


def new_key():
    # Same shape as the chart's `randAlphaNum 64`: 64 characters, ~380 bits.
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(64))


class Vault:
    def __init__(self, url, mount, header, tmp):
        self.url, self.mount, self.header, self.tmp = url.rstrip("/"), mount, header, tmp

    def _curl(self, args, body=None):
        out = os.path.join(self.tmp, "resp")
        r = subprocess.run(
            ["curl", "-sS", "-o", out, "-w", "%{http_code}", "-H", "@" + self.header] + args,
            input=body, capture_output=True, text=True)
        code = r.stdout.strip()[-3:] if r.stdout else ""
        data = ""
        if os.path.exists(out):
            with open(out) as f:
                data = f.read()
            os.remove(out)
        if r.returncode != 0:
            raise Refused(f"curl failed (exit {r.returncode}) — network, ACL or SM_URL")
        return code, data

    def read(self, path):
        """→ (value-dict, version) or (None, 0) when absent."""
        code, data = self._curl([f"{self.url}/v1/{self.mount}/data/{path}"])
        if code == "404":
            return None, 0
        if code != "200":
            raise Refused(f"reading {path} answered HTTP {code or '?'} (token expired? the reader/writer may not read it?)")
        d = (json.loads(data).get("data") or {})
        return d.get("data") or {}, int((d.get("metadata") or {}).get("version") or 0)

    def write(self, path, values, cas):
        body = json.dumps({"options": {"cas": cas}, "data": values})
        code, _ = self._curl(["-X", "POST", "-H", "Content-Type: application/json", "--data-binary", "@-",
                              f"{self.url}/v1/{self.mount}/data/{path}"], body=body)
        if code not in ("200", "204"):
            raise Refused(f"writing {path} answered HTTP {code or '?'} (a writer token? cas conflict = someone wrote it meanwhile)")


def cluster_value(ctx, ns, name, key):
    """The live Secret's value for <key>, or None when the Secret is absent. Never printed."""
    r = subprocess.run(["kubectl", "--context", ctx, "-n", ns, "get", "secret", name, "-o", "json"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        if "NotFound" in r.stderr or "not found" in r.stderr:
            return None, {}
        raise Refused(f"cannot read the Secret {name} in {ns} (context {ctx})")
    import base64
    d = json.loads(r.stdout)
    raw = (d.get("data") or {}).get(key)
    if raw is None:
        raise Refused(f"the Secret {name} has no key {key}")
    return base64.b64decode(raw).decode(), (d.get("metadata") or {}).get("labels") or {}


def check_header(path):
    if not path or not os.path.isfile(path):
        raise Refused("SM_HEADER must name a file holding 'X-Vault-Token: <token>' (docs/ops/external-secrets-migration.md §2)")
    if os.stat(path).st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise Refused(f"SM_HEADER {path} is readable by others — chmod 600 it")


def main(argv):
    p = argparse.ArgumentParser(add_help=False)
    p.add_argument("cmd", nargs="?")
    p.add_argument("--instance-id")
    p.add_argument("--prefix")
    p.add_argument("--remote-key")
    p.add_argument("--previous-remote-key")
    p.add_argument("--previous-secret")
    p.add_argument("--context", default="dmagenticos")
    p.add_argument("--namespace", default="agentic-os")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("-h", "--help", action="store_true")
    try:
        a = p.parse_args(argv)
    except SystemExit:
        return 2
    if a.help:
        print(__doc__)
        return 0
    if a.cmd not in ("create", "migrate", "verify", "rotate"):
        print("usage: conn-key-secrets-manager.py create|migrate|verify|rotate --instance-id <id> [options] (--help)", file=sys.stderr)
        return 2
    if not a.instance_id:
        print("--instance-id is required (the Secrets Manager instance ID)", file=sys.stderr)
        return 2
    prefix = a.prefix or a.namespace
    rkey = a.remote_key or f"{prefix}/{KEY_SECRET}"
    rprev = a.previous_remote_key or f"{prefix}/{PREV_SECRET}"
    url = os.environ.get("SM_URL", "https://prod.sm.eu01.stackit.cloud")

    tmp = tempfile.mkdtemp(prefix="conn-key-")
    os.chmod(tmp, 0o700)
    try:
        check_header(os.environ.get("SM_HEADER", ""))
        v = Vault(url, a.instance_id, os.environ["SM_HEADER"], tmp)
        dry = " (DRY RUN — nothing written)" if a.dry_run else ""
        print(f"conn-key {a.cmd}: Secrets Manager {url}, mount {a.instance_id}, key {rkey}{dry}")

        if a.cmd == "create":
            remote, _ = v.read(rkey)
            if remote is not None:
                raise Refused(f"{rkey} already exists ({fp(remote.get(KEY, ''))}) — create never overwrites. "
                              "Use verify, or rotate for a deliberate key change.")
            key = new_key()
            if a.dry_run:
                print(f"would write a new 64-character key to {rkey} (cas=0)")
                return 0
            v.write(rkey, {KEY: key}, cas=0)
            back, _ = v.read(rkey)
            if (back or {}).get(KEY) != key:
                raise Refused(f"read-back of {rkey} does not match what was written")
            print(f"written {rkey}: {fp(key)} (read back: same)")
            print("next: externalSecrets.managed += os-secrets-encryption-key (docs/ops/connection-keys.md §2)")
            return 0

        if a.cmd in ("migrate", "verify"):
            items = [(KEY_SECRET, KEY, rkey)]
            if a.previous_secret:
                items.append((a.previous_secret, PREV, rprev))
            bad = 0
            for name, key, path in items:
                live, labels = cluster_value(a.context, a.namespace, name, key)
                if live is None:
                    raise Refused(f"the Secret {name} is not in {a.namespace} (context {a.context}) — nothing to {a.cmd}")
                if key == KEY and len(live.strip()) < MIN_LEN:
                    raise Refused(f"the live {name} is shorter than {MIN_LEN} characters — os-ui would not accept it either")
                owner = "Helm (chart-generated)" if labels.get("app.kubernetes.io/managed-by") == "Helm" else "not Helm"
                remote, _ = v.read(path)
                rv = None if remote is None else remote.get(key)
                print(f"  {name:38s} live {fp(live)} [{owner}]   vault {fp(rv) if rv is not None else 'ABSENT'}")
                if a.cmd == "verify":
                    if rv != live:
                        bad = 1
                    continue
                if rv is not None and rv == live:
                    print(f"  {name}: already in Secrets Manager, same fingerprint — nothing to write")
                    continue
                if rv is not None:
                    raise Refused(f"{path} already holds ANOTHER key ({fp(rv)}). Migrating would replace it; "
                                  "ESO would then write a key that cannot open the stored credentials. Find out "
                                  "which is right first (docs/ops/connection-keys.md, 'Fingerprints differ').")
                if a.dry_run:
                    print(f"  would write {name} → {path} (cas=0)")
                    continue
                v.write(path, {key: live}, cas=0)
                back, _ = v.read(path)
                bv = (back or {}).get(key)
                if bv != live:
                    raise Refused(f"read-back of {path}: {fp(bv) if bv else 'nothing'} ≠ live {fp(live)}")
                print(f"  {name}: written, read back {fp(bv)} = live")
            if a.cmd == "verify":
                print("SAME — the vault holds the live key(s)" if not bad else
                      "DIFFERS — the vault copy is not the live key; do NOT let ESO own the Secret until this is resolved")
                return bad
            if not a.dry_run:
                print("next: the handover is not needed for this Secret (it already carries helm.sh/resource-policy: keep);"
                      " add os-secrets-encryption-key to externalSecrets.managed (docs/ops/connection-keys.md §2)")
            return 0

        if a.cmd == "rotate":
            cur, ver = v.read(rkey)
            if cur is None or not cur.get(KEY):
                raise Refused(f"{rkey} does not exist — nothing to rotate (use create or migrate)")
            prev, pver = v.read(rprev)
            older = [x for x in ((prev or {}).get(PREV, "")).split(",") if x.strip()]
            chain = [cur[KEY]] + [x for x in older if x != cur[KEY]]
            key = new_key()
            print(f"  current {fp(cur[KEY])} (version {ver}) becomes previous; previous will hold {len(chain)} key(s)")
            if a.dry_run:
                print(f"  would write {rprev} (cas={pver}) then a new key to {rkey} (cas={ver})")
                return 0
            v.write(rprev, {PREV: ",".join(chain)}, cas=pver)
            v.write(rkey, {KEY: key}, cas=ver)
            back, _ = v.read(rkey)
            if (back or {}).get(KEY) != key:
                raise Refused(f"read-back of {rkey} does not match what was written")
            print(f"  written: previous = {', '.join(fp(x) for x in chain)}; current = {fp(key)}")
            print("next: docs/ops/connection-keys.md §4 — previousKeysSecret, force-sync both ExternalSecrets, restart os-ui + os-ui-worker")
            return 0
    except Refused as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
