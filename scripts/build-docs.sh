#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# build-docs.sh — regenerate the Sovereign Agentic OS end-user guide PDF.
# =============================================================================
# SINGLE regen entry point for the manual. When the OS changes:
#   1. edit  docs/Sovereign-Agentic-OS-Guide.md   (the source of truth)
#   2. run   ./scripts/build-docs.sh              (refreshes the .pdf)
#   3. commit both the .md and the regenerated .pdf
# (Can be wired as `make docs`.)
#
# HOW IT WORKS
#   - Markdown -> PDF via DOCKERIZED pandoc (no host pandoc/LaTeX install needed).
#   - The source .md carries {{DATE}} and {{GIT_COMMIT}} placeholders. They are
#     substituted INTO A TEMP COPY at build time from `git log -1` (so the source
#     stays reproducible / re-runnable). The committed .md keeps the placeholders.
#   - Idempotent: re-running just rebuilds the PDF. One-time cost is the docker
#     image pull (see IMAGE below); cached afterwards.
#
# ENGINES (first that works wins; override with PDF_ENGINE=eisvogel|plain|chrome|npx):
#   1. eisvogel  - pandoc/extra (ships the Eisvogel template: title page + styled TOC)
#   2. plain     - pandoc/latex (xelatex, --toc), no template
#   3. chrome    - md -> HTML (pandoc/core) then headless-Chrome print-to-PDF
#   4. npx       - md-to-pdf via `npx` (needs network + node)
#
# USAGE
#   ./scripts/build-docs.sh                 # auto-detect engine
#   PDF_ENGINE=plain ./scripts/build-docs.sh
#   KEEP_TMP=1 ./scripts/build-docs.sh      # keep the substituted working file
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
DOCS="$ROOT/docs"
SRC="$DOCS/Sovereign-Agentic-OS-Guide.md"
OUT="$DOCS/Sovereign-Agentic-OS-Guide.pdf"
WORK="$DOCS/.guide.build.md"             # temp, placeholder-substituted working copy
PDF_ENGINE="${PDF_ENGINE:-auto}"

c() { printf "\033[1;36m%s\033[0m\n" "$*"; }
ok() { printf "\033[1;32m✓ %s\033[0m\n" "$*"; }
die() { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

[ -f "$SRC" ] || die "Source not found: $SRC"
command -v docker >/dev/null 2>&1 || command -v npx >/dev/null 2>&1 \
  || die "Need either docker (for pandoc) or npx (for md-to-pdf) on PATH."

# --- 1. stamp the build metadata into a temp working copy --------------------
DATE="$(git log -1 --format=%cd --date=format:'%Y-%m-%d' 2>/dev/null || date +%Y-%m-%d)"
COMMIT="$(git log -1 --format=%h 2>/dev/null || echo 'uncommitted')"
c "Stamping build metadata (date=$DATE commit=$COMMIT)…"
sed -e "s/{{DATE}}/$DATE/g" -e "s/{{GIT_COMMIT}}/$COMMIT/g" "$SRC" > "$WORK"
cleanup() { [ "${KEEP_TMP:-0}" = 1 ] || rm -f "$WORK"; }
trap cleanup EXIT

# Dockerized pandoc. A function (not a string) so paths with spaces mount safely.
pdoc() { docker run --rm -v "$DOCS:/data" -w /data "$@"; }
WORK_REL="$(basename "$WORK")"
OUT_REL="$(basename "$OUT")"

have_image() { docker image inspect "$1" >/dev/null 2>&1; }

build_eisvogel() {  # pandoc/extra ships the Eisvogel template -> nice title page + TOC
  c "Engine: pandoc/extra + Eisvogel (dockerized)…"
  pdoc pandoc/extra "$WORK_REL" -o "$OUT_REL" \
    --from gfm --template eisvogel --listings \
    --toc --toc-depth=2 --number-sections \
    --pdf-engine=xelatex -V geometry:margin=1in -V colorlinks=true
}

build_plain() {     # pandoc/latex -> xelatex, no template
  c "Engine: pandoc/latex + xelatex (dockerized)…"
  pdoc pandoc/latex "$WORK_REL" -o "$OUT_REL" \
    --from gfm --toc --toc-depth=2 --number-sections \
    --pdf-engine=xelatex -V geometry:margin=1in -V colorlinks=true \
    -V linkcolor:'[HTML]{0B5394}' -V toccolor:'[HTML]{0B5394}'
}

build_chrome() {    # md -> HTML (pandoc/core, arm64-native) -> Chrome print-to-PDF (CDP)
  c "Engine: pandoc/core HTML + headless Chrome…"
  command -v docker >/dev/null 2>&1 || { c "No docker for the HTML render step."; return 1; }
  # Locate a Chrome/Chromium binary first (no point rendering HTML otherwise).
  local CHROME=""
  for cand in "google-chrome" "chromium" "chromium-browser" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    if command -v "$cand" >/dev/null 2>&1; then CHROME="$(command -v "$cand")"; break; fi
    [ -x "$cand" ] && { CHROME="$cand"; break; }
  done
  [ -n "$CHROME" ] || { c "No Chrome/Chromium found for the HTML print path."; return 1; }

  # \newpage is a LaTeX directive; strip standalone occurrences for the HTML path
  # (page breaks are driven by the stylesheet's `h1 { break-before: page }`).
  local HWORK="$DOCS/.guide.html.md"
  sed '/^\\newpage$/d' "$WORK" > "$HWORK"

  # The Apple-grade print design is the committed, reviewable stylesheet
  # docs/assets/guide.css (self-hosted brand fonts under docs/assets/fonts/).
  # pandoc embeds the CSS + fonts so guide.html is fully offline; +yaml_metadata_block
  # turns the front-matter into the cover (#title-block-header).
  pdoc pandoc/core "$(basename "$HWORK")" -o guide.html \
    --from gfm+yaml_metadata_block --toc --toc-depth=2 --number-sections \
    --standalone --embed-resources --resource-path /data --css assets/guide.css

  # Short version label for the running footer (parsed from the front-matter).
  local VER; VER="$(sed -n 's/^date: *"\(Chart [0-9.]*\).*/\1/p' "$SRC" | head -1)"

  # Print via the zero-dependency Node CDP driver — gives a clean cover plus a real
  # running footer with page numbers (Chrome's CLI print cannot). Falls back to the
  # CLI print path (no custom footer) if Node/CDP is unavailable.
  if command -v node >/dev/null 2>&1 \
     && node "$ROOT/scripts/lib/html-to-pdf.mjs" "$DOCS/guide.html" "$OUT" "$CHROME" --version "$VER"; then
    :
  else
    c "Node CDP driver unavailable; using Chrome CLI print (no custom footer)…"
    "$CHROME" --headless=new --disable-gpu --no-pdf-header-footer \
      --print-to-pdf="$OUT" "file://$DOCS/guide.html" >/dev/null 2>&1 \
      || "$CHROME" --headless --disable-gpu --no-pdf-header-footer \
         --print-to-pdf="$OUT" "file://$DOCS/guide.html"
  fi
  rm -f "$DOCS/guide.html" "$HWORK"
  [ -f "$OUT" ]
}

build_npx() {       # last-resort: md-to-pdf via npx (needs node + network)
  c "Engine: md-to-pdf via npx…"
  ( cd "$DOCS" && npx --yes md-to-pdf "$WORK_REL" && mv "${WORK_REL%.md}.pdf" "$OUT_REL" )
}

# --- 2. pick an engine -------------------------------------------------------
run_auto() {
  # The canonical, product-grade output is the native HTML + headless-Chrome path
  # (docs/assets/guide.css): the Apple-grade cover/typography only render there, it
  # is fast + offline on any arch (incl. Apple Silicon), and pandoc/core is amd64+arm64.
  build_chrome && return 0
  if command -v docker >/dev/null 2>&1; then
    # Fallbacks: pandoc + LaTeX. amd64-only images, so only when already cached.
    c "Chrome path unavailable; trying cached pandoc LaTeX images…"
    if have_image pandoc/extra; then build_eisvogel && return 0; fi
    if have_image pandoc/latex; then build_plain && return 0; fi
  fi
  command -v npx >/dev/null 2>&1 && build_npx && return 0
  return 1
}

case "$PDF_ENGINE" in
  eisvogel) build_eisvogel ;;
  plain)    build_plain ;;
  chrome)   build_chrome ;;
  npx)      build_npx ;;
  auto)     run_auto || die "All PDF engines failed. Try: PDF_ENGINE=plain $0" ;;
  *)        die "Unknown PDF_ENGINE='$PDF_ENGINE' (eisvogel|plain|chrome|npx|auto)" ;;
esac

[ -f "$OUT" ] || die "PDF was not produced."
SIZE="$(du -h "$OUT" | cut -f1 | tr -d ' ')"
ok "Built $OUT ($SIZE) from commit $COMMIT ($DATE)."
