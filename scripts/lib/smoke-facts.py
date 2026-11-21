#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""smoke-facts.py — the parsing half of scripts/smoke-test.sh. Shell orchestrates; this reads.

  python3 scripts/lib/smoke-facts.py values < helm-get-values-all.json
      Print the NON-SECRET facts the smoke test needs from a release's computed values, one
      `name=value` per line. The input holds credentials; only the keys named in FACTS are ever
      read, and nothing else is printed.
  python3 scripts/lib/smoke-facts.py chart-size <chart values.yaml>
      Print `clickhouse.persistence.size` from the chart's own values file.
  python3 scripts/lib/smoke-facts.py ge <quantity> <quantity>
      Exit 0 when the first Kubernetes quantity (e.g. 30Gi) is >= the second.
  python3 scripts/lib/smoke-facts.py models-without-info < litellm config.yaml
      Print each `model_list` entry that has no `model_info`, then `models=<n>`.

Why Python: the same reason scripts/deploy.sh uses it — YAML and JSON in shell are guesswork.
"""
import json
import sys

import yaml

# fact name -> path in the release values. Hostnames, sizes, flags: never a credential.
FACTS = {
    'public_host': 'ingress.hosts.osUI',
    'gateway_host': 'ingress.hosts.litellm',
    'langfuse_host': 'ingress.hosts.langfuse',
    'langfuse_enabled': 'langfuse.enabled',
    'clickhouse_persistence': 'clickhouse.persistence.enabled',
    'clickhouse_size': 'clickhouse.persistence.size',
    'apps_enabled': 'softwareRunner.enabled',
    'apps_namespace': 'softwareRunner.namespace',
}

UNITS = {'': 1, 'k': 10**3, 'M': 10**6, 'G': 10**9, 'T': 10**12,
         'Ki': 2**10, 'Mi': 2**20, 'Gi': 2**30, 'Ti': 2**40}


def lookup(tree, dotted):
    for part in dotted.split('.'):
        if not isinstance(tree, dict):
            return None
        tree = tree.get(part)
    return tree


def render(value):
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'true' if value else 'false'
    return str(value)


def to_bytes(quantity):
    q = str(quantity).strip()
    number = q.rstrip('kMGTi')
    return float(number) * UNITS[q[len(number):]]


def cmd_values():
    tree = json.load(sys.stdin) or {}
    for name, path in FACTS.items():
        print(f'{name}={render(lookup(tree, path))}')


def cmd_chart_size(path):
    print(render(lookup(yaml.safe_load(open(path)), FACTS['clickhouse_size'])))


def cmd_ge(a, b):
    sys.exit(0 if to_bytes(a) >= to_bytes(b) else 1)


def cmd_models_without_info():
    config = yaml.safe_load(sys.stdin) or {}
    models = config.get('model_list') or []
    for entry in models:
        if not (isinstance(entry, dict) and entry.get('model_info')):
            print((entry or {}).get('model_name', '<unnamed>'))
    print(f'models={len(models)}')


if __name__ == '__main__':
    cmd, args = sys.argv[1], sys.argv[2:]
    {'values': cmd_values, 'chart-size': cmd_chart_size, 'ge': cmd_ge,
     'models-without-info': cmd_models_without_info}[cmd](*args)
