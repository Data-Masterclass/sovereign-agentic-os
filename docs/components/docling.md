# Docling — document parsing

**What it is:** Docling (MIT) — a doc-parsing service (`docling-serve`) that converts uploaded
documents (PDF/DOCX/HTML…) into clean **markdown** for the knowledge index. **Off by default
locally** (RAM); on by default for STACKIT.

## Enable it
Turn it on in the Admin Console, or set `docling.enabled: true` and `helm upgrade`.

## Access (API)
```bash
kubectl -n agentic-os port-forward svc/docling 5001:5001
curl -s localhost:5001/version                       # docling-serve 1.25.x
curl -s -X POST localhost:5001/v1/convert/file \
  -F "files=@some.pdf;type=application/pdf" -F to_formats=md   # -> { document: { md_content }, status }
```
The routes are under `/v1/` (`/v1/convert/file`, `/v1/convert/file/async`,
`/v1/status/poll/{task_id}`, `/v1/result/{task_id}`; `/openapi-3.0.json` lists them). There is
**no** `/convert`.

## How the OS uses it (Files)
An uploaded **binary document** — PDF, DOCX, PPTX, XLSX, EPUB — has no text of its own, so the
upload door (`tabs/files/lib/extract.ts`, wired in `pipeline-server.ts`) reads the stored bytes
from the object store and sends them to `POST /v1/convert/file/async` (multipart field `files`,
`to_formats=md`, `do_ocr=true`), long-polls `/v1/status/poll/{id}` and fetches
`/v1/result/{id}`. The markdown is **stored on the file** — so `get_file`, the preview and
search all read it — and then indexed. The original bytes are never rewritten.

- An upload waits `UPLOAD_EXTRACT_WAIT_MS` (20 s) for this; a longer conversion finishes in the
  background (`DOCLING_TIMEOUT_MS`, 10 min) and the file shows **Extracting text…** meanwhile.
- When Docling is unreachable, times out, rejects the document or finds no text, the upload
  still succeeds and the file is **Stored only** with the specific reason
  (`indexing.extraction.reason`). Nothing is invented, on any setting of `OS_OFFLINE_MOCK`.
- A `restricted` file and a file its owner opted out of indexing are never sent here.
- **Recovering files uploaded before this worked:** Platform → Re-index → Files → Plan → Run
  (or the MCP tool `reindex_corpus`). A file that is stored-only only because it had no text is
  planned as `missing-representation` and its text is read from the stored bytes. One file can
  be retried from its preview (**Extract text**).
- **Where the reader sees it:** a file with an inline viewer (PDF, image, audio, video) has a
  view switch above the viewer — **Original** (default) / **Extracted text** / **Details** —
  and, once extracted, a line under the title ("Text extracted · 877 characters · date"). The
  extracted text used to sit below the 88vh PDF frame, where nobody found it.
- Text-like uploads (txt, md, csv, json, html…) never come here: their bytes are their text.

## Building the image behind a proxy, a firewall or a mirror
`images/extensions/docling/Dockerfile` downloads the allowlisted model weights from Hugging Face
**at build time** (the running image is `HF_HUB_OFFLINE=1` and never downloads). Three build
arguments cover restricted networks:

| Build arg | Effect |
|---|---|
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | Docker's predefined proxy args: every `RUN` sees them without an `ARG` line, and they stay out of the image history. |
| `HF_ENDPOINT` | A Hugging Face mirror (e.g. `https://hf-mirror.example.com`). Empty = `https://huggingface.co`. |
| `HF_HUB_DISABLE_XET=1` | Download over plain HTTP instead of the Xet protocol (for a mirror or proxy that does not handle Xet). |

```bash
docker build --build-arg HTTPS_PROXY=http://proxy.corp:3128 \
  -t sovereign-os/docling:local images/extensions/docling
```

Without a mirror the build needs these hosts (HTTPS, port 443). This is Hugging Face's own list,
["Downloading behind a proxy or firewall"](https://huggingface.co/docs/hub/models-downloading#downloading-behind-a-proxy-or-firewall)
(checked 2026-11-27). Downloads follow redirects from `huggingface.co`, so allowing that host alone
is not enough:

| Host | Purpose |
|---|---|
| `huggingface.co` | Hub API, metadata, download redirects |
| `cas-server.xethub.hf.co`, `cas-server.xethub-eu.hf.co` | Xet protocol API (US, EU) |
| `transfer.xethub.hf.co`, `transfer.xethub-eu.hf.co` | Xet storage downloads (US, EU) |
| `us.aws.cdn.hf.co`, `us.gcp.cdn.hf.co` | CDN edges |
| `cdn-lfs-us-1.hf.co`, `cdn-lfs-eu-1.hf.co` | LFS CDN (US, EU) |

Hugging Face says these hosts can change. Where your proxy supports suffix matching, allow the
suffixes `hf.co` and `huggingface.co` instead. Note that `*.xethub.hf.co` does **not** cover
`*.xethub-eu.hf.co`, and a single-label wildcard `*.hf.co` does not cover `us.aws.cdn.hf.co` or
`cas-server.xethub.hf.co`. The machine-readable list is at
`https://huggingface.co/.well-known/meta.json`.

## FAQ
**Q: Why off locally?** It pulls ML models and is RAM-heavy; toggled off so the full L1–L3
slice fits a 14 GB kind VM.
**Q: How does it feed RAG?** Parsed markdown → embedded → OpenSearch knowledge index → agents' RAG.
