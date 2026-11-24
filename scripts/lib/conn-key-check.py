#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""conn-key-check.py — can the connection credentials be recovered after a restore?

    conn-key-check.py <manifest.yaml> [--live --status <file>]

<file> holds the JSON of os-ui's GET /api/platform-admin/encryption-keys?summary=1 (service bearer),
read IN-CLUSTER by smoke-test.sh (`kubectl exec` into os-ui → 127.0.0.1) — never the public internet.

Connection credentials are sealed under a data key that a KEY PROVIDER wraps (os-ui
core/infra/key-manager.ts). The master key of the default `builtin` provider is the Secret
os-secrets-encryption-key, which is excluded from Velero — so on prod either a RECOVERY KEY must have
been confirmed as saved, or the master key must live outside the cluster (STACKIT KMS, or ESO from
STACKIT Secrets Manager).

<manifest.yaml> is what Helm applies (deploy.sh: the render of this upgrade) or what Helm owns
(smoke-test.sh: `helm get manifest`). From os-ui's Deployment it reads the key Secret name
(OS_SECRETS_ENCRYPTION_KEY[_PREVIOUS] secretKeyRef), OS_KEY_PROVIDER and OS_SECRETS_NAMESPACE.

Always (render): when OS_KEY_PROVIDER=eso the key Secret(s) must NOT be rendered by the chart and an
ExternalSecret must write them (in the manifest, or live in the namespace).
--live (smoke): os-ui's own verdict `connectionKeys` (the --status file) — computed from the key
record it verified (HMAC under the builtin key), never from a raw annotation anyone could edit.
status must be `ready`; then:
  builtin           → sovereign-os.io/recovery-confirmed must be "true"
  eso               → the live ExternalSecret(s) are Ready and the Secret exists
  stackit (others)  → ok (the master key is outside the cluster); a missing recovery key is a NOTE.

Cluster reads use $KUBECTL (e.g. "kubectl --context dmagenticos") and $NS (release namespace), for the
ESO checks only: `get externalsecrets -o json` (no values) and `get secret … -o name` — a Secret's data
is NEVER read. Fails closed. Exit 0 ok (or "skip": os-ui renders no key), 1 not recoverable / unreadable,
2 usage. Only names are printed.
"""
import json
import os
import shlex
import subprocess
import sys

import yaml

KEY_ENV = "OS_SECRETS_ENCRYPTION_KEY"
PREV_ENV = "OS_SECRETS_ENCRYPTION_KEY_PREVIOUS"


def main(argv):
    health_file = ""
    if "--status" in argv:
        i = argv.index("--status")
        health_file = argv[i + 1] if i + 1 < len(argv) else ""
        argv = argv[:i] + argv[i + 2:]
    args = [a for a in argv if a != "--live"]
    live = "--live" in argv
    if len(args) != 1:
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 2
    try:
        docs = [d for d in yaml.safe_load_all(open(args[0])) if isinstance(d, dict) and d.get("kind")]
    except (OSError, yaml.YAMLError) as e:
        print(f"FAIL cannot read the manifest {args[0]}: {type(e).__name__}")
        return 1

    dep = next((d for d in docs if d["kind"] == "Deployment" and (d.get("metadata") or {}).get("name") == "os-ui"), None)
    if dep is None:
        print("skip os-ui is not in the manifest: no connection-credential key to check")
        return 0
    secrets, values = {}, {}
    for c in ((dep.get("spec") or {}).get("template") or {}).get("spec", {}).get("containers") or []:
        for e in c.get("env") or []:
            ref = (e.get("valueFrom") or {}).get("secretKeyRef") or {}
            if e.get("name") in (KEY_ENV, PREV_ENV) and ref.get("name"):
                secrets[e["name"]] = ref["name"]
            elif "value" in e:
                values[e.get("name")] = str(e["value"])
    if KEY_ENV not in secrets:
        print(f"skip os-ui reads no {KEY_ENV}: this chart has no durable connection-credential store")
        return 0
    eso = values.get("OS_KEY_PROVIDER") == "eso"
    kubectl = shlex.split(os.environ.get("KUBECTL", "kubectl"))
    ns = os.environ.get("NS", "agentic-os")
    bad = 0

    def k(*a):
        return subprocess.run(kubectl + ["-n", ns] + list(a), capture_output=True, text=True)

    def target(es):
        return ((es.get("spec") or {}).get("target") or {}).get("name") or (es.get("metadata") or {}).get("name")

    live_es_cache = {}

    def live_es():
        if "v" not in live_es_cache:
            r = k("get", "externalsecrets", "-o", "json")
            if r.returncode != 0:
                raise RuntimeError("cannot list ExternalSecrets (is ESO installed?)")
            live_es_cache["v"] = {target(i): i for i in json.loads(r.stdout).get("items") or []}
        return live_es_cache["v"]

    # 1. ESO consistency (render-level; deploy.sh runs this before anything changes).
    if eso:
        rendered = {d["metadata"]["name"] for d in docs if d["kind"] == "Secret"}
        manifest_es = {target(d) for d in docs if d["kind"] == "ExternalSecret"}
        for env, name in secrets.items():
            if name in rendered:
                print(f"FAIL {name} ({env}) is rendered by the chart although OS_KEY_PROVIDER=eso")
                bad = 1
                continue
            try:
                found = name in manifest_es or name in live_es()
                if not found:
                    print(f"FAIL {name} ({env}) is written by no ExternalSecret (externalSecrets.managed)")
                    bad = 1
                    continue
                if live:
                    es = live_es().get(name)
                    ready = es and any(c.get("type") == "Ready" and c.get("status") == "True" for c in (es.get("status") or {}).get("conditions") or [])
                    if not ready:
                        print(f"FAIL {name} ({env}): its ExternalSecret is not Ready in the cluster")
                        bad = 1
                        continue
                    if k("get", "secret", name, "-o", "name").returncode != 0:
                        print(f"FAIL {name} ({env}): the Secret does not exist")
                        bad = 1
                        continue
            except (RuntimeError, ValueError) as e:
                print(f"FAIL {name} ({env}): {e}")
                bad = 1
                continue
            print(f"ok   {name} ({env}) is written by ESO from STACKIT Secrets Manager")
    if not live:
        if not bad:
            print(f"ok   key provider at first boot: {'eso' if eso else 'builtin'} (recoverability is checked on the live release)")
        return bad

    # 2. Live: what os-ui itself verified (the HMAC-signed key record), read in-cluster.
    if not health_file:
        print("FAIL --live needs --status <file>: the JSON of os-ui's encryption-keys summary")
        return 1
    try:
        ck = (json.load(open(health_file)) or {}).get("connectionKeys")
    except (OSError, ValueError) as e:
        print(f"FAIL the key status from os-ui is not readable JSON ({type(e).__name__})")
        return 1
    if not isinstance(ck, dict):
        err = ""
        try:
            err = (json.load(open(health_file)) or {}).get("error", "")
        except (OSError, ValueError, AttributeError):
            err = ""
        print(f"FAIL os-ui reported no connectionKeys{f' ({err})' if err else ''} — older than envelope encryption, not answering, or the service bearer was refused")
        return 1
    status, provider, recovery = ck.get("status"), ck.get("provider") or "", ck.get("recovery")
    if status != "ready":
        print(f"FAIL the connection-credential keys are {status!s} (locked / unavailable / failed) — Platform → Encryption keys")
        return 1
    confirmed = recovery == "confirmed"
    if provider == "builtin":
        if confirmed:
            print("ok   builtin master key with a confirmed recovery key")
        else:
            print("FAIL builtin master key WITHOUT a confirmed recovery key: a restore or a lost cluster would lose every stored connection credential (Platform → Encryption keys)")
            bad = 1
    elif provider == "eso" and not eso:
        # The record says ESO holds the master key, but this render does not wire it (OS_KEY_PROVIDER):
        # check the live ExternalSecret directly.
        name = secrets[KEY_ENV]
        try:
            es = live_es().get(name)
        except (RuntimeError, ValueError) as e:
            es = None
            print(f"FAIL {name}: {e}")
            bad = 1
        ready = es and any(c.get("type") == "Ready" and c.get("status") == "True" for c in (es.get("status") or {}).get("conditions") or [])
        if not bad and not ready:
            print(f"FAIL the key record names the eso provider, but no Ready ExternalSecret writes {name}")
            bad = 1
        elif not bad:
            print(f"ok   master key held by ESO (STACKIT Secrets Manager); {name} synced")
    elif provider:
        print(f"ok   master key held by the {provider} provider (outside the cluster's backups)")
        if not confirmed:
            print("note no recovery key confirmed — recommended as a second way in (Platform → Encryption keys)")
    else:
        print("FAIL os-ui names no key provider")
        bad = 1
    return bad

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
