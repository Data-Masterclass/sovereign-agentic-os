# Docs

User-facing documentation for the Sovereign Agentic OS.

| File | What it is |
|---|---|
| [`Sovereign-Agentic-OS-Guide.md`](Sovereign-Agentic-OS-Guide.md) | **The official end-user guide** — install, operate, and understand the platform. The single source of truth (Markdown). |
| `Sovereign-Agentic-OS-Guide.pdf` | The same guide as a polished, distributable PDF. **Generated — do not edit by hand.** |
| [`getting-started.md`](getting-started.md) | The short quickstart (also rendered in the Admin Console). |
| [`stackit-deployment-guide.md`](stackit-deployment-guide.md) | **Deploy to STACKIT — recommended: single node.** The primary, end-to-end cloud install (single `g2i.8` node, self-contained). |
| [`cloud-configuration.md`](cloud-configuration.md) | What you set up to deploy on STACKIT / your cloud. |
| [`components/`](components/) | The 28 per-component guides (access, login, usage, FAQ). |

## Keeping the guide up to date

The guide is **reproducible**. When the OS changes:

1. Edit **`docs/Sovereign-Agentic-OS-Guide.md`** (the source of truth — never edit the PDF).
2. Run the single regen entry point:

   ```bash
   ./scripts/build-docs.sh
   ```

3. Commit **both** the updated `.md` and the regenerated `.pdf`.

This can also be wired as a `make docs` target.

### How the PDF is generated

`scripts/build-docs.sh` converts the Markdown to PDF using **dockerized pandoc** — no host
pandoc/LaTeX install is required (only Docker, plus Chrome/Chromium for the default engine on
Apple Silicon). It is idempotent; the only one-time cost is the initial Docker image pull.

The build is engine-flexible and picks the first that works (override with `PDF_ENGINE=…`):

| `PDF_ENGINE` | Tooling | Notes |
|---|---|---|
| `chrome` | `pandoc/core` (arm64-native) → HTML → headless Chrome (CDP) | **Default, product-grade output.** Native, fast, fully offline. Styled by the committed Apple-grade print stylesheet `docs/assets/guide.css` (dark brand cover, TOC, self-hosted brand fonts under `docs/assets/fonts/`, restrained gold accent). Printed via the zero-dependency CDP driver `scripts/lib/html-to-pdf.mjs` (Node ≥ 22), which adds a running footer with page numbers. Falls back to Chrome's CLI print if Node/CDP is unavailable. |
| `eisvogel` | `pandoc/extra` + Eisvogel LaTeX template | Fallback; **amd64 only** (used when the image is already cached). |
| `plain` | `pandoc/latex` + xelatex | Fallback LaTeX, no template; **amd64 only**. |
| `npx` | `md-to-pdf` via `npx` | Last-resort fallback (needs Node + network). |

The build date and commit are stamped from `git log -1` into the `{{DATE}}` / `{{GIT_COMMIT}}`
placeholders in the Markdown **at build time** (substituted into a temporary working copy, so the
committed `.md` keeps the placeholders and stays reproducible).

```bash
# Examples
./scripts/build-docs.sh                 # auto-detect engine
PDF_ENGINE=plain ./scripts/build-docs.sh   # force LaTeX (on an amd64 host / with the image cached)
KEEP_TMP=1 ./scripts/build-docs.sh      # keep the substituted working file for debugging
```
