#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# license-check.sh — license allowlist gate for the Sovereign Agentic OS bundle.
# =============================================================================
# What it does:
#   1. (syft) Generates a CycloneDX SBOM of the repo so the dependency surface is
#      machine-derived, then scans it for hard-denied licenses (ELv2/BSL/SSPL/...).
#   2. (authoritative) Reads the curated bundled-component manifest
#      (licenses/components.tsv) and checks every BUNDLED component's SPDX id
#      against the allowlist (licenses/allowed-licenses.txt). Anything not
#      allowlisted — or matching the deny list (licenses/denied-licenses.txt) —
#      FAILS the gate.
#
# Why two passes: the manifest is the deterministic gate over the platform
# components we actually redistribute (so the check is stable and the SSPL test
# is clean). syft additionally catches anything in the source tree and hard-fails
# on the deny set; non-allowlisted *transitive application* licenses it discovers
# (e.g. LGPL/CC-BY in our own images' npm/pip deps) are reported as warnings, not
# failures — they are dependencies of our own code, not separately-redistributed
# platform components.
#
# Data files (override via env): ALLOW_FILE, DENY_FILE, COMPONENTS_FILE, SBOM_FILE
# Flags:
#   --update-sbom   regenerate and overwrite the committed SBOM_FILE (sbom.cdx.json)
#   --no-syft       skip the syft pass (manifest gate only)
#
# Exit 0 = pass, non-zero = a disallowed/denied license was found.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIC_DIR="$ROOT/licenses"
ALLOW_FILE="${ALLOW_FILE:-$LIC_DIR/allowed-licenses.txt}"
DENY_FILE="${DENY_FILE:-$LIC_DIR/denied-licenses.txt}"
COMPONENTS_FILE="${COMPONENTS_FILE:-$LIC_DIR/components.tsv}"
SBOM_FILE="${SBOM_FILE:-$ROOT/sbom.cdx.json}"

UPDATE_SBOM=0
USE_SYFT=1
for arg in "$@"; do
  case "$arg" in
    --update-sbom) UPDATE_SBOM=1 ;;
    --no-syft)     USE_SYFT=0 ;;
    -h|--help)     sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

red(){ printf '\033[31m%s\033[0m\n' "$*"; }
grn(){ printf '\033[32m%s\033[0m\n' "$*"; }
ylw(){ printf '\033[33m%s\033[0m\n' "$*"; }

[[ -f "$ALLOW_FILE" ]]      || { red "missing allowlist: $ALLOW_FILE"; exit 2; }
[[ -f "$COMPONENTS_FILE" ]] || { red "missing manifest: $COMPONENTS_FILE"; exit 2; }

# --- load allow + deny sets (portable; no mapfile, works on bash 3.2) --------
ALLOW=(); DENY=()
while IFS= read -r line; do ALLOW+=("$line"); done < <(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$ALLOW_FILE" | sed 's/[[:space:]]*$//')
if [[ -f "$DENY_FILE" ]]; then
  while IFS= read -r line; do DENY+=("$line"); done < <(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$DENY_FILE" | sed 's/[[:space:]]*$//')
fi

is_allowed(){ local id="$1"; for a in "${ALLOW[@]}"; do [[ "$id" == "$a" ]] && return 0; done; return 1; }
deny_hit(){ # case-insensitive substring match against deny list; echoes the matched term
  local s="$1" lc; lc="$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]')"
  for d in "${DENY[@]}"; do
    [[ -z "$d" ]] && continue
    local dl; dl="$(printf '%s' "$d" | tr '[:upper:]' '[:lower:]')"
    [[ "$lc" == *"$dl"* ]] && { printf '%s' "$d"; return 0; }
  done
  return 1
}

fail=0; warn=0

echo "== Sovereign Agentic OS — license gate =="
echo "allowlist : $ALLOW_FILE  (${#ALLOW[@]} ids)"
echo "manifest  : $COMPONENTS_FILE"
echo

# --- pass 1: syft SBOM -------------------------------------------------------
if [[ "$USE_SYFT" -eq 1 ]] && command -v syft >/dev/null 2>&1; then
  scan_sbom="$SBOM_FILE"
  if [[ "$UPDATE_SBOM" -eq 1 ]]; then
    echo "syft: regenerating $SBOM_FILE ..."
    SYFT_CHECK_FOR_APP_UPDATE=false syft scan "dir:$ROOT" -o "cyclonedx-json=$SBOM_FILE" -q
  else
    scan_sbom="$(mktemp)"; trap 'rm -f "$scan_sbom"' EXIT
    echo "syft: scanning source tree (temp SBOM) ..."
    SYFT_CHECK_FOR_APP_UPDATE=false syft scan "dir:$ROOT" -o "cyclonedx-json=$scan_sbom" -q
  fi
  # Extract distinct license tokens from the CycloneDX SBOM and classify them.
  while IFS=$'\t' read -r token count; do
    [[ -z "$token" ]] && continue
    if d="$(deny_hit "$token")"; then
      red "DENY  syft-discovered license '$token' (x$count) matches forbidden '$d'"; fail=1
    elif ! is_allowed "$token"; then
      ylw "warn  syft-discovered license '$token' (x$count) not in allowlist (transitive app dep — informational)"; warn=1
    fi
  done < <(python3 - "$scan_sbom" <<'PY'
import json,sys,re,collections
data=json.load(open(sys.argv[1]))
c=collections.Counter()
def toks(expr):
    # split SPDX expression into bare ids
    for t in re.split(r'\s+(?:AND|OR|WITH)\s+|[()]', expr):
        t=t.strip()
        if t and t.upper() not in ('AND','OR','WITH'):
            c[t]+=1
for comp in data.get('components',[]):
    for lic in comp.get('licenses',[]):
        l=lic.get('license',{})
        idv=l.get('id') or l.get('name')
        if idv: c[idv]+=1
        elif lic.get('expression'): toks(lic['expression'])
for k,v in sorted(c.items()):
    print(f"{k}\t{v}")
PY
  )
else
  [[ "$USE_SYFT" -eq 1 ]] && ylw "syft not found on PATH — skipping SBOM pass (manifest gate still runs)."
fi
echo

# --- pass 2: authoritative manifest gate ------------------------------------
echo "Checking bundled components in manifest ..."
checked=0
while IFS=$'\t' read -r name version spdx bundled lfile note; do
  [[ "$name" =~ ^[[:space:]]*# ]] && continue
  [[ "$name" == "name" ]] && continue
  [[ -z "${name// }" ]] && continue
  spdx="$(printf '%s' "$spdx" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  bundled="$(printf '%s' "$bundled" | sed 's/[[:space:]]//g')"
  [[ -z "$spdx" ]] && continue
  [[ "$bundled" == "no" ]] && { ylw "skip  $name ($spdx) — bundled=no (not redistributed)"; continue; }
  checked=$((checked+1))
  if d="$(deny_hit "$spdx")"; then
    red "DENY  $name -> $spdx (matches forbidden '$d')"; fail=1; continue
  fi
  if is_allowed "$spdx"; then
    grn "ok    $name -> $spdx"
  else
    red "FAIL  $name -> $spdx NOT in allowlist"; fail=1
  fi
done < "$COMPONENTS_FILE"

echo
echo "checked $checked bundled components; warnings=$warn"
if [[ "$fail" -ne 0 ]]; then
  red "LICENSE GATE: FAIL — a disallowed/denied license is present."
  exit 1
fi
grn "LICENSE GATE: PASS — all bundled component licenses are allowlisted."
