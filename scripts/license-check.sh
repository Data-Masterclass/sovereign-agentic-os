#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# license-check.sh — the licence gate for the Sovereign Agentic OS (policy of 2026-11-22).
# =============================================================================
# The policy is ONE file, licenses/policy.json (allowed / forbidden licences, attribution rule); reviewed
# exceptions live in licenses/exceptions.json. scripts/license-gate.mjs enforces it for the WHOLE repo:
#   - npm      os-ui and the app-scaffold lockfiles
#   - python   every image's pip dependencies (resolved with pip; needs network)
#   - component licenses/components.tsv (container images, charts, Go binaries)
# Weak copyleft / GPL programs pass only with a reviewed exception whose condition fits; AGPL and source-available never.
# Dual-licensed packages pass when ANY option is allowed and the chosen option is printed. Anything other
# than Apache-2.0 / MIT needs an attribution entry (THIRD-PARTY-LICENSES.md or licenses/ATTRIBUTIONS.md).
# Then it runs the version floors a licence list cannot express (metricflow, dbt-core).
#
# Flags:
#   --update-sbom   regenerate and overwrite the committed SBOM_FILE (sbom.cdx.json) with syft
#   --no-syft       accepted for compatibility; the SBOM is only (re)generated with --update-sbom
#   --no-python     skip the pip resolution (offline use)
#   --strict        also fail on the known violations listed in licenses/known-violations.json
#
# Env: SBOM_FILE, PYTHON (interpreter with pip >= 22.2)
# Exit 0 = pass, non-zero = a disallowed/unknown/unattributed licence (or a stale known-violation entry).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SBOM_FILE="${SBOM_FILE:-$ROOT/sbom.cdx.json}"

UPDATE_SBOM=0
GATE_ARGS=(--python-resolve)
for arg in "$@"; do
  case "$arg" in
    --update-sbom) UPDATE_SBOM=1 ;;
    --no-syft)     ;;
    --no-python)   GATE_ARGS=() ;;
    --strict)      GATE_ARGS+=(--strict) ;;
    -h|--help)     sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

red(){ printf '\033[31m%s\033[0m\n' "$*"; }
grn(){ printf '\033[32m%s\033[0m\n' "$*"; }
ylw(){ printf '\033[33m%s\033[0m\n' "$*"; }

fail=0

if [[ "$UPDATE_SBOM" -eq 1 ]]; then
  if command -v syft >/dev/null 2>&1; then
    echo "syft: regenerating $SBOM_FILE ..."
    SYFT_CHECK_FOR_APP_UPDATE=false syft scan "dir:$ROOT" -o "cyclonedx-json=$SBOM_FILE" -q
  else
    red "syft not found on PATH — cannot --update-sbom."; fail=1
  fi
fi

# --- pass 1: the licence policy (licenses/policy.json) -----------------------
command -v node >/dev/null 2>&1 || { red "node not found on PATH — the licence gate needs it."; exit 2; }
if ! node "$ROOT/scripts/license-gate.mjs" ${GATE_ARGS[@]+"${GATE_ARGS[@]}"}; then fail=1; fi

echo
# --- pass 3: version floors a licence deny-list cannot express ---------------
# A pip specifier carries no SPDX id, so `licenses/policy.json` cannot catch it. MetricFlow
# <= 0.208.1 is Business Source License 1.1 whose Additional Use Grant excludes this product's
# use, and BSL does not relax retroactively: the Apache-2.0 relicensing at v0.209.0 is not
# backdated. Enforced wherever metricflow could enter a build (checklist M14).
echo "Checking version floors (metricflow >= 0.209.0, dbt-core >= 1.9) ..."
if command -v node >/dev/null 2>&1; then
  if (cd "$ROOT" && node scripts/metricflow-floor.mjs); then :; else fail=1; fi
else
  ylw "node not found on PATH — skipping the metricflow version floor (CI always has node)."
fi

echo
if [[ "$fail" -ne 0 ]]; then
  red "LICENSE GATE: FAIL — see the findings above."
  exit 1
fi
grn "LICENSE GATE: PASS."
