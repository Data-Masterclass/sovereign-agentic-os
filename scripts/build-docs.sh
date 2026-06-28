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

build_chrome() {    # md -> HTML (pandoc/core, arm64-native) -> Chrome print-to-PDF
  c "Engine: pandoc/core HTML + headless Chrome…"
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
  # (page breaks are driven by the print stylesheet's h1 { page-break-before }).
  local HWORK="$DOCS/.guide.html.md"
  sed '/^\\newpage$/d' "$WORK" > "$HWORK"

  # A print stylesheet: title page, comfortable typography, bordered tables,
  # page-break before each top-level section, repeating table headers.
  local CSS="$DOCS/.guide.css"
  cat > "$CSS" <<'CSSEOF'
@page { size: A4; margin: 22mm 18mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
  font-size: 10.5pt; line-height: 1.5; color: #1b1f24; max-width: 100%; margin: 0; }
#title-block-header { text-align: center; page-break-after: always;
  padding-top: 28vh; border-bottom: none; }
#title-block-header .title { font-size: 30pt; font-weight: 800; color: #0d1b2a;
  border-bottom: 3px solid #1F6FEB; padding-bottom: 12px; display: inline-block; }
#title-block-header .subtitle { font-size: 13pt; color: #3a4654; margin-top: 18px; }
#title-block-header .author, #title-block-header .date { font-size: 10.5pt; color: #5a6673; }
nav#TOC { page-break-after: always; }
nav#TOC > ul { list-style: none; padding-left: 0; }
nav#TOC ul ul { padding-left: 1.4em; }
nav#TOC a { text-decoration: none; color: #0B5394; }
h1 { font-size: 19pt; color: #0d1b2a; border-bottom: 2px solid #1F6FEB;
  padding-bottom: 5px; margin-top: 0; page-break-before: always; page-break-after: avoid; }
h1:first-of-type { page-break-before: avoid; }
nav#TOC + h1 { page-break-before: avoid; }
h2 { font-size: 14pt; color: #11335c; margin-top: 1.4em; page-break-after: avoid; }
h3 { font-size: 11.5pt; color: #1F6FEB; margin-top: 1.1em; page-break-after: avoid; }
a { color: #1F6FEB; }
code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 9pt;
  background: #f2f4f7; padding: 1px 4px; border-radius: 3px; }
pre { background: #0d1b2a; color: #e6edf3; padding: 12px 14px; border-radius: 6px;
  font-size: 8.6pt; line-height: 1.45; overflow-x: auto; page-break-inside: avoid; }
pre code { background: none; color: inherit; padding: 0; }
table { border-collapse: collapse; width: 100%; font-size: 9pt; margin: 12px 0;
  page-break-inside: avoid; }
th, td { border: 1px solid #d0d7de; padding: 5px 8px; text-align: left;
  vertical-align: top; }
thead th { background: #1F6FEB; color: #fff; }
tbody tr:nth-child(even) { background: #f6f8fa; }
blockquote { border-left: 4px solid #1F6FEB; background: #eef4fc; margin: 12px 0;
  padding: 8px 14px; color: #2b3a4a; }
hr { border: none; border-top: 1px solid #d0d7de; margin: 1.6em 0; }
img { max-width: 100%; }
CSSEOF

  pdoc pandoc/core "$(basename "$HWORK")" -o guide.html \
    --from gfm --toc --toc-depth=2 --number-sections \
    --standalone --embed-resources --css "$(basename "$CSS")"

  "$CHROME" --headless=new --disable-gpu --no-pdf-header-footer \
    --print-to-pdf="$OUT" "file://$DOCS/guide.html" >/dev/null 2>&1 \
    || "$CHROME" --headless --disable-gpu --no-pdf-header-footer \
       --print-to-pdf="$OUT" "file://$DOCS/guide.html"
  rm -f "$DOCS/guide.html" "$HWORK" "$CSS"
  [ -f "$OUT" ]
}

build_npx() {       # last-resort: md-to-pdf via npx (needs node + network)
  c "Engine: md-to-pdf via npx…"
  ( cd "$DOCS" && npx --yes md-to-pdf "$WORK_REL" && mv "${WORK_REL%.md}.pdf" "$OUT_REL" )
}

# --- 2. pick an engine -------------------------------------------------------
run_auto() {
  if command -v docker >/dev/null 2>&1; then
    # Best output: pandoc + LaTeX (Eisvogel template). Those images are amd64-only,
    # so only use them when already cached (otherwise emulation/pull is slow/fails).
    if have_image pandoc/extra; then build_eisvogel && return 0; fi
    if have_image pandoc/latex; then build_plain && return 0; fi
    # Native, fast, offline on any arch (incl. Apple Silicon): pandoc/core + Chrome.
    c "No cached LaTeX image; using the native HTML + Chrome path…"
    build_chrome && return 0
    # Last resort within docker: pull the amd64 LaTeX images (emulated).
    c "Chrome path unavailable; trying to pull pandoc LaTeX images…"
    build_eisvogel && return 0
    build_plain && return 0
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
