#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# add-spdx-headers.sh — prepend SPDX/copyright headers to OUR OWN source.
# =============================================================================
# Adds, to each of our own .py and .sh source files:
#
#   # SPDX-License-Identifier: Apache-2.0
#   # Copyright 2026 Borek Data Ventures UG
#
# Scope (our code only): images/**, scripts/**, and install.sh.
# Skips:
#   - os-ui/** and images/os-ui/**  (the OS UI app owns its own headers)
#   - vendored / generated trees: node_modules, .next, dist, build, .venv,
#     __pycache__, vendor, charts/  (upstream subcharts)
#   - YAML, Dockerfiles, requirements.txt, SQL/CSV, etc. (only .py/.sh handled)
#   - files that already carry an SPDX-License-Identifier line (idempotent)
#
# Both .py and .sh use '#' line comments. A shebang (#!) is preserved: the header
# is inserted immediately after it.
#
# Usage: scripts/add-spdx-headers.sh [--check]
#   --check   list files that WOULD be changed and exit 1 if any (no writes).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPDX_ID="SPDX-License-Identifier: Apache-2.0"
COPYRIGHT="Copyright 2026 Borek Data Ventures UG"

CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1

# Collect candidate files: our .py/.sh under images/ and scripts/, plus install.sh
collect(){
  { find "$ROOT/images" "$ROOT/scripts" -type f \( -name '*.py' -o -name '*.sh' \) 2>/dev/null
    [[ -f "$ROOT/install.sh" ]] && echo "$ROOT/install.sh"
  } | sort -u
}

skip_path(){
  case "$1" in
    */os-ui/*|*/node_modules/*|*/.next/*|*/dist/*|*/build/*|*/.venv/*|\
*/__pycache__/*|*/vendor/*|"$ROOT"/charts/*) return 0 ;;
  esac
  return 1
}

changed=0; scanned=0; skipped=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if skip_path "$f"; then skipped=$((skipped+1)); continue; fi
  scanned=$((scanned+1))
  if grep -q "SPDX-License-Identifier" "$f"; then continue; fi
  rel="${f#$ROOT/}"
  if [[ "$CHECK" -eq 1 ]]; then echo "would add header: $rel"; changed=$((changed+1)); continue; fi

  tmp="$(mktemp)"
  first="$(head -1 "$f")"
  if [[ "$first" == '#!'* ]]; then
    {
      printf '%s\n' "$first"
      printf '# %s\n' "$SPDX_ID"
      printf '# %s\n' "$COPYRIGHT"
      tail -n +2 "$f"
    } > "$tmp"
  else
    {
      printf '# %s\n' "$SPDX_ID"
      printf '# %s\n' "$COPYRIGHT"
      cat "$f"
    } > "$tmp"
  fi
  # preserve executable bit
  if [[ -x "$f" ]]; then chmod +x "$tmp"; fi
  cat "$tmp" > "$f"
  rm -f "$tmp"
  echo "header added: $rel"
  changed=$((changed+1))
done < <(collect)

echo
echo "scanned=$scanned skipped=$skipped changed=$changed"
if [[ "$CHECK" -eq 1 && "$changed" -ne 0 ]]; then
  echo "missing SPDX headers (run scripts/add-spdx-headers.sh)"; exit 1
fi
