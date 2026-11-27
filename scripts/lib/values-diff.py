#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""values-diff.py — show, BEFORE a deploy, which release values change and which ones win.

  python3 scripts/lib/values-diff.py <live.yaml> <chart values.yaml> <derived.yaml> [overlay.yaml]

WHY. scripts/deploy.sh derives the release's values from the LIVE release, so a value the
release already pins beats a changed chart default, silently: on 2026-11-19 a chart change
did not reach production for exactly that reason. This prints three short lists:

  1. what this upgrade changes in the release values (live -> derived + overlay),
  2. where the release overrides the chart's default (the chart's new default will NOT apply;
     change it with VALUES_OVERLAY),
  3. what the release sets that the chart's values.yaml does not define (it has an effect only
     if a subchart reads it; otherwise it does nothing).

Information only: it never fails a deploy. It NEVER prints a secret: a value is shown only when
its path has no secret-like word in it AND it is a number, a boolean, or a short plain word
(sizes, tags, hostnames); everything else prints as `(hidden)`.
"""
import re
import sys

import yaml

SECRET_PATH = re.compile(r'secret|pass|pwd|key|token|cred|auth|dsn|salt|cert|private', re.I)
PLAIN_WORD = re.compile(r'^[A-Za-z0-9._-]{0,48}$')
MISSING = object()   # a path that is not set at all (distinct from an explicit null)


def load(path):
    with open(path) as f:
        return yaml.safe_load(f) or {}


def merge(base, over):
    """Helm's rule: maps merge key by key, anything else (lists included) replaces."""
    if not (isinstance(base, dict) and isinstance(over, dict)):
        return over
    out = dict(base)
    for key, value in over.items():
        out[key] = merge(base.get(key), value) if key in base else value
    return out


def flatten(tree, prefix=''):
    """{'a': {'b': 1}} -> {'a.b': 1}. Lists and empty maps are leaves."""
    if isinstance(tree, dict) and tree:
        flat = {}
        for key, value in tree.items():
            flat.update(flatten(value, f'{prefix}.{key}' if prefix else str(key)))
        return flat
    return {prefix: tree}


# Free-form maps the chart reads but deliberately does not default in values.yaml: their children are
# the operator's to name. `ingress.hosts` lost its `{}` default (it made Helm print "destination for
# litellm.ingress.hosts is a table" on every render, PR #413); its keys (osUI, osUIApex, dagster, ...) still
# take effect, so they must not be reported as "not defined (no effect)".
FREE_FORM_MAPS = ('ingress.hosts',)


def defined(path, chart):
    """The chart defines a path when it lists it, lists an ancestor as an empty map — a
    free-form map such as `ingress.hosts: {}`, whose children are the operator's to name — or the path
    lies under one of FREE_FORM_MAPS."""
    if any(path == m or path.startswith(m + '.') for m in FREE_FORM_MAPS):
        return True
    parts = path.split('.')
    for i in range(len(parts), 0, -1):
        prefix = '.'.join(parts[:i])
        if prefix in chart:
            return i == len(parts) or chart[prefix] == {}
    return False


def show(path, value):
    if value is MISSING:
        return '(unset)'
    if SECRET_PATH.search(path):
        return '(hidden)'
    if value is None or isinstance(value, (bool, int, float)):
        return yaml.safe_dump(value).strip().removesuffix('...').strip()
    if isinstance(value, str) and PLAIN_WORD.match(value):
        return value or '""'
    return '(list)' if isinstance(value, list) else '(hidden)'


def section(title, lines):
    print(f'   {title}: {len(lines) or "none"}')
    for line in lines:
        print(f'     {line}')


def main(live_path, chart_path, derived_path, overlay_path=None):
    live = flatten(load(live_path))
    chart = flatten(load(chart_path))
    final_tree = load(derived_path)
    if overlay_path:
        final_tree = merge(final_tree, load(overlay_path))
    final = flatten(final_tree)

    changed = []
    for p in sorted(set(live) | set(final)):
        before, after = live.get(p, MISSING), final.get(p, MISSING)
        if before != after:
            changed.append(f'{p}: {show(p, before)} -> {show(p, after)}')
    overrides = [f'{p}: release {show(p, v)}, chart default {show(p, chart[p])}'
                 for p, v in sorted(final.items()) if p in chart and chart[p] != v]
    undefined = [p for p in sorted(final) if not defined(p, chart)]

    section('values this upgrade changes (live -> new)', changed)
    section('release values that override the chart default (the chart default does NOT apply)', overrides)
    section("release values the chart's values.yaml does not define (no effect unless a subchart reads them)", undefined)


if __name__ == '__main__':
    if len(sys.argv) not in (4, 5):
        sys.exit(__doc__)
    main(*sys.argv[1:])
