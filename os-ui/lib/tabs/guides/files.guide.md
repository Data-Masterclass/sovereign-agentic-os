# Files — golden path

## What this is

The Files tab stores binary and document assets — PDFs, spreadsheets, images, process documentation, and any file that supports other OS work. Uploaded files are automatically extracted, chunked, and embedded for semantic search, making them retrievable by agents and knowledge tools. Restricted files are stored but not indexed. In the cross-tab spine, files are a lateral surface: they support knowledge authoring and agent grounding rather than sitting in the main analytics column.

## How to build it

1. **Dedupe check.** Call `search_files` with a description of the file you intend to upload. If a matching file already exists at Shared or above, use it rather than creating a duplicate. Duplicate files fragment the embedded search index.
2. **Upload.** Call `upload_file` with:
   - `file` — binary content or URL
   - `name` — display name
   - `description` — a human-readable summary (required for promotion eligibility)
   - `tags` — at least one tag (required for promotion eligibility)
   - `restricted` — set `true` to store the file without indexing it (e.g. for PII-containing documents)
   The file is created as Personal. If `restricted` is false (the default), text is extracted, chunked, and embedded automatically.
3. **Read it back.** Call `get_file` with the file id to read back the metadata (tags, description, sensitivity, version history) and the extracted text. Long text is truncated at ~8k characters with an explicit note; a `restricted` file returns metadata only — its text is never returned.
4. **File a promotion request.** Creator calls `request_promotion` to move the file from Personal to Shared. Requires `description` and at least one `tag` to be present; missing either returns `bad_request`.
5. ⛔ **Builder approves.** A Builder or Admin calls `approve_promotion`. The file becomes visible to domain members and its embeddings are merged into the shared search index.

## What to consider

- **search_files before upload_file.** The embedded index grows with every upload. A file that already exists at Shared is already searchable — uploading a duplicate creates noise in agent retrieval.
- **description + tags are the promotion gate.** `request_promotion` on a file without both returns `bad_request`. Fill these fields at upload time.
- **restricted files are not searchable.** Setting `restricted: true` means the file is stored encrypted and cannot be retrieved via `search_files` or agent knowledge retrieval. Use this for files containing PII, credentials, or legal material that must not be indexed.
- **Extraction is automatic for non-restricted files.** You do not need to call a separate index step (unlike Knowledge). The pipeline runs on upload.
- **Idempotency.** `upload_file` with the same name in the same domain returns `conflict` if the file is already at the same tier. Re-promoting an already-Shared file returns `conflict` — treat as idempotent.

## Governance

| Step | Role required |
|---|---|
| `list_files`, `search_files`, `get_file` | Creator |
| `upload_file` | Creator (own work) |
| `request_promotion` | Creator |
| ⛔ `approve_promotion` | Builder or Admin |

OPA enforces domain scope on file reads. DLS on files respects the tier ladder — a Personal file is invisible to other users even if they know its ID. Restricted files are additionally scoped to their uploader until a Builder explicitly shares them. Langfuse traces every file access and promotion event.

**Worked example:**

```
search_files({ query: "Q3 invoice reconciliation process", domain: "finance" })
→ [] — no existing file on this topic

upload_file({ name: "q3-invoice-reconciliation.pdf", file: <binary>,
  description: "Step-by-step reconciliation process for Q3 invoice exceptions",
  tags: ["invoices", "finance", "process"], domain: "finance" })
→ { id: "fi_12K...", state: "personal", indexed: true, chunkCount: 11 }

request_promotion({ id: "fi_12K..." })
→ { state: "pending_approval", requestId: "pr_13L..." }
```

A Builder then calls `approve_promotion({ requestId: "pr_13L..." })` to make the file visible to the finance domain and merge its embeddings into the shared index.
