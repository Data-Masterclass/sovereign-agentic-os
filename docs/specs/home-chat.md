# Home chat — spec

Home becomes one large chat that does what the signed-in user may do. The golden-path tiles stay,
smaller, above the chat. This spec was written from our own requirements; other chat products were
read for design input only (their docs, features and public behaviour). No code, styles, assets or
file structure were taken from any of them.

## Principles

1. One tool surface. The chat calls the same governed MCP dispatch as the UI and external MCP clients:
   as the user, role floor, OPA, RLS/DLS, audit, one Langfuse trace per turn. No second tool layer.
2. Models only through LiteLLM with central keys and budgets. Users have no model keys.
3. A write never runs on the model's say-so. It is parked, shown, and runs once when the same user
   confirms it in the same conversation.
4. A refusal is typed (`code`, `reason`, `hint`) and shown in plain words with the next step.
5. Everything on screen is data rendered as text. No model-authored markup.

## What ships when

| Phase | Content |
|---|---|
| PR 1 | Layout (chat first, compact tiles, phone width), the chat on the existing Ask-the-OS engine, live tool steps, confirm-before-write, plain-language typed errors, links to the real artifact |
| PR 2 | Conversations stored per user (private), history list, "Save as" KPI / dashboard / knowledge note / agent through the existing create tools, streamed answer tokens, Stop |

## Design input, adopted and skipped

| Practice (as seen in other chat products) | Decision | Why / how it maps to the OS |
|---|---|---|
| Empty state with starter prompts | Adopted | Four starters that call read tools; shown only when the conversation is empty |
| Show tool calls as compact, expandable steps | Adopted | One line per governed tool call (name, ok / refused / waiting), expandable for the typed error or arguments; steps stream as they finish |
| Stop generation | Adopted | Aborts the request; a write that is already parked stays parked and can still be declined |
| Streaming answer text | Adopted (PR 2) | The gateway call is made with `stream: true`; tokens reach the browser as they arrive and the finished text equals a non-streamed answer. Steps stream too |
| Ask the user before an action | Adopted, stricter | A server-side gate, not a prompt rule: parked call, card with the exact arguments (secrets masked), Run / Cancel, single use, 10 minutes |
| Error with retry | Adopted | The failed message keeps its text; a Retry button resends it; typed refusals are explained, not retried |
| Conversation list with titles, per-user storage | Adopted (PR 2) | Stored per user id server-side; another user's id answers "not found" |
| Regenerate, edit a message, branch the conversation | Skipped for now | Needs a message tree in storage; the confirm gate is bound to one conversation, so branching would need its own rules. Revisit after history ships |
| Attachments | Skipped | Files enter through Files so they are governed, classified and indexed; the chat can reference a file by name through `search_files` |
| @-mentions of artifacts | Skipped for now | The page context already tells the assistant which artifact is open; mentions need an artifact picker with the same visibility rules |
| Slash commands | Skipped | The MCP prompts already exist per golden path; a later change can list them |
| Own model picker, own RAG, own user store, community tool store | Skipped | Models are central; knowledge and files are governed tools; identity is the OS's |
| Keyboard: Enter sends, Shift+Enter newline, Esc stops | Adopted | Plain textarea behaviour; no custom shortcut layer |
| Mobile: single column, input pinned to the bottom | Adopted | Tiles collapse to a one-row horizontal strip at phone width |
| Share links, public chats | Skipped | Conversations are private by default; sharing is not in scope |

## Behaviour (PR 1)

- `POST /api/assistant/chat` with `conversationId` and `stream: true` turns the confirm gate on and
  returns newline-delimited JSON: `step` events, then one `done` event with the final answer,
  `tools[]`, `pending[]` and `traceId`. Without those two fields the call behaves as before (the drawer).
- `POST /api/assistant/chat` with `confirmation: { id, conversationId, decision }` runs or cancels one
  parked write. Arguments come from the stored record. The call goes through the same governed
  dispatch as the user, so a denial comes back typed.
- A tool the user's role cannot use is not offered to the model; if it is named anyway it returns the
  typed `forbidden` error (it is not parked).
- Results that name an artifact link to its tab with `?focus=<id>` from a fixed route map.

## Tests

- A creator's chat cannot call a gated tool (twin: a domain admin can reach it).
- A write is parked and never reaches the dispatch before confirmation; runs once after (twin: a
  read runs straight through; a declined write never runs).
- User B cannot confirm or decline user A's pending write; another conversation cannot either.
- The tiles keep their routes (twin: a dimmed tile has no create action).
- Real-container proof: one Langfuse trace per turn and an OPA decision (see the PR).

## Behaviour (PR 2)

- `os-conversations` store (in process + best-effort OpenSearch mirror), every function scoped by the caller's
  user id; another user's conversation is `not found` on list, read, continue and delete, through
  `/api/assistant/conversations[/id]`, `/api/assistant/chat`, and the MCP reads `list_conversations` /
  `get_conversation`. A parked write's arguments are never stored.
- "Save as" sends a kind (never a tool name). A fixed table maps it to the one existing create tool
  (`define_metric`, `create_dashboard`, `save_knowledge_note`, `create_agent_system`); the turn is
  restricted to that tool and its call is parked behind the same confirm card. A kind the role is not
  offered is not shown.
- Streaming: `LlmRequest.onToken` makes the gateway caller stream; the ACT call's text is sent as `token`
  events. Stop aborts the model calls through the request signal.

## Attaching files (drag and drop, paste, Attach)

**For users.** In the Home chat and in the Ask-the-OS drawer you can drag files onto the chat, paste
them, or press **Attach** (a normal button, so Tab + Enter works) to pick them. Each file shows as a
chip that says where it will land; change it with the chip's menu before you send:

| What you attach | Goes to (default) | You may change it to |
|---|---|---|
| CSV, TSV, Parquet, JSON, NDJSON, Excel (.xlsx) | **Data** — a new private dataset, Bronze ingested | Files |
| PDF, Word (.docx), PowerPoint (.pptx) | **Files** — stored as-is, made searchable (Docling) | — |
| Markdown (.md) | **Knowledge** — a personal note | Files |
| Plain text (.txt) | **Files** | Knowledge |

- The type is read from the file's **content**, not only its name: a `.txt` that is really
  comma-separated is data; a `.csv` that is really a PDF is filed as a PDF; a binary file named `.csv`
  is refused. ZIP archives, older Office formats (.xls/.doc/.ppt), HTML and other types are refused with
  a reason. A text file that is not UTF-8 is refused with a hint to save it as UTF-8 ("CSV UTF-8").
- An Excel workbook lands its **first sheet** (the chip says which, when there are several). A sheet too
  large to read here is refused with a hint to save it as CSV.
- Limits: at most **5 files per message**; a file's own limit is the one its destination already has
  (Data and Files: the upload limit, 200 MB by default; Knowledge: 512 KB per note); a message's files
  together may not exceed the upload limit.
- Everything lands in **your My scope**, owned by you, never shared or promoted. Sharing to Domain or
  Company stays the normal, approved promotion.
- When you send, the files are uploaded first and your message starts with a short block naming what
  was created (with its id and link), so the assistant can use it in the same turn — "summarise the
  dataset I just uploaded" works.

**How it works.** `POST /api/assistant/attachments` (multipart: `file` ×n, `destinations` JSON array)
→ `core/runtime/chat-attachments-server.ts` `routeAttachments`. Per file: sanitise the name → sniff the
content (`core/runtime/chat-attachments.ts`, the same sniff the composer runs on the first/last 64 KB)
→ check the chosen destination against the closed routing table → **OPA `agentic.authz.upload_create`**
(never fails open) → the owning tab's existing service through the boot wiring
`os-ui/chat-attachment-sinks.ts` (Data: `createDatasetService` + `ingestAndRegisterBronze`, xlsx via
`readXlsxSheet` + `landGridAsBronze`; Files: `storeUploadedFile`, the Files upload's own path; Knowledge:
`createPersonalKnowledge`) → one audit record per file (`assistant.attachment.create`: who, file, kind,
destination, outcome, item id). A denied or refused file writes nothing; a failed ingest deletes the
dataset it had just created. The same `upload_create` decision now also guards the Files upload
(`POST /api/files`), "New dataset" (`POST /api/data/datasets`) and a personal note
(`POST /api/knowledge/personal`); `uploadCreateDecision` in `core/infra/governed.ts` is its one owner.

Tests: `core/runtime/chat-attachments.test.ts` (sniff, routing, limits, OPA deny/unreachable, audit),
`core/ui/chat-attachments-view.test.ts` (chips: admit, 6th file, destination change, results),
`tests/chat/chat-attachment-sinks.test.ts` (the real Data/Files/Knowledge services),
`authz_test.rego`, and `tests/opa/upload-create.int.test.ts` (real OPA, fail closed).
