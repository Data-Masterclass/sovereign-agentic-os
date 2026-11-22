# Knowledge — golden path

## What a knowledge note is

A **knowledge note** is a titled, free-form markdown document in your **My knowledge**: a report, a
summary, a result, a piece of know-how. It is the artifact of the Knowledge tab. It is **not a
workflow**: a workflow (steps + actors, the documentation of a business process) is a different
artifact with its own tab and its own tools (see the Workflows guide: `author_workflow`).

If you are asked to "save this as knowledge", "keep this answer", "store the report" — that is
`save_knowledge_note`. Never `author_workflow`.

## The tools

| Tool | What it does |
|---|---|
| `save_knowledge_note(title, md, folder?, domain?, sourceKey?)` | Save a note into My knowledge, optionally in a folder. Personal and owner-only. Repeating a call with the same `sourceKey` returns the note already saved. The note is indexed so `search_knowledge` finds it, for its owner only. |
| `list_knowledge(folder?)` | The notes you can see: My · Domain · Company, each with its `pk_…` id, title and folder. |
| `get_knowledge(id)` | One note: title, markdown, folder, scope. |
| `search_knowledge(query, k?)` | Governed hybrid retrieval (dense + lexical, reranked) with provenance. OPA `retrieve` gate + document-level grant filter. The index also holds the text of indexed workflows (their ids start `wf_`); a note hit has a `pk_…` id. |
| `export_okf_bundle` · `import_okf_bundle` | OKF (Open Knowledge Format) v0.2 interchange. The exported bundle is built from a workflow; an import lands governed artifacts at Personal tier. |

## How to use it

1. **Look first.** `list_knowledge` or `search_knowledge` — extend what exists rather than saving a duplicate.
2. **Save.** `save_knowledge_note` with a title and the markdown body. Pass a `sourceKey` when a program
   saves, so a retry does not write a second note.
3. **Share (optional).** A creator files `request_promotion({kind:"personal_knowledge", id})`; a
   domain admin approves. Nothing is shared until then.
4. **Ground an agent.** Grant the note (or its folder) to an agent system under *Knowledge*. A
   workflow is granted under *Workflows*, not here.

## Governance

| Step | Role required |
|---|---|
| `search_knowledge`, `list_knowledge`, `get_knowledge`, `save_knowledge_note` | Creator (own work) |
| Share a note with the domain | Creator files, domain admin approves |

A note is Personal: *owner only*, not an admin, not a domain admin. Filing `request_promotion` is the
owner asking for it to be shared, and from that point the appointed approver may read the record in
order to decide it. Nothing else widens, and a note nobody filed stays private.

The audience gate is `visibility` (My · Domain · Company). A second promotion is refused with
`This knowledge is already promoted`.
