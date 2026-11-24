#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""conn-key-check.py — can the connection credentials be recovered after a restore?

    conn-key-check.py <manifest.yaml> [--live]

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
--live (smoke): the key record Secret `os-conn-keyring` in the conn-secrets namespace exists; its
NON-secret annotations name the provider and whether the recovery key was confirmed:
  builtin           → sovereign-os.io/recovery-confirmed must be "true"
  eso               → the live ExternalSecret(s) are Ready and the Secret exists
  stackit (others)  → ok (the master key is outside the cluster); a missing recovery key is a NOTE.

Live reads use $KUBECTL (e.g. "kubectl --context dmagenticos") and $NS (release namespace):
`get externalsecrets -o json` (no values) and `get secret … -o jsonpath=<metadata>` — a Secret's data is
NEVER read. Fails closed. Exit 0 ok (or "skip": os-ui renders no key), 1 not recoverable / unreadable,
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
KEYRING = "os-conn-keyring"
ANN_PROVIDER = "sovereign-os.io/key-provider"
ANN_RECOVERY = "sovereign-os.io/recovery-confirmed"


def main(argv):
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
    conn_ns = values.get("OS_SECRETS_NAMESPACE") or f"{os.environ.get('NS', 'agentic-os')}-conn-secrets"
    kubectl = shlex.split(os.environ.get("KUBECTL", "kubectl"))
    ns = os.environ.get("NS", "agentic-os")
    bad = 0

    def k(*a, namespace=ns):
        return subprocess.run(kubectl + ["-n", namespace] + list(a), capture_output=True, text=True)

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

    # 2. Live: the key record's non-secret annotations.
    r = k("get", "secret", KEYRING, "-o", "jsonpath={.metadata.annotations}", namespace=conn_ns)
    if r.returncode != 0:
        print(f"FAIL the key record {conn_ns}/{KEYRING} cannot be read (os-ui has not initialised the credential store, or no access)")
        return 1
    try:
        ann = json.loads(r.stdout or "{}")
    except ValueError:
        print(f"FAIL the key record {conn_ns}/{KEYRING} has unreadable annotations")
        return 1
    provider = ann.get(ANN_PROVIDER, "")
    confirmed = ann.get(ANN_RECOVERY) == "true"
    if provider in ("", "builtin"):
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
    else:
        print(f"ok   master key held by the {provider} provider (outside the cluster's backups)")
        if not confirmed:
            print("note no recovery key confirmed — recommended as a second way in (Platform → Encryption keys)")
    return bad


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
