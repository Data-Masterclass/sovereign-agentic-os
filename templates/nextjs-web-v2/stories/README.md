# Stories: the living spec of this app

This folder is the app's requirements, kept in git. The Sovereign OS Stories view, the chat and the MCP tools read and
write these same files; you can edit them here and push. Every change is a commit, so the history of a story is its git
history.

```
stories/
  EP-1-order-intake/
    _epic.md              # the epic: id, title, description, requirements
    US-3-submit-order.md  # one file per user story
```

## Rules the OS checks on every push

- **Ids are assigned by the OS** (`EP-<n>`, `US-<n>`, `AC-<n>`) and never reused. To add a story or a criterion, create
  it in the OS (Stories view, chat or MCP), which picks the next free id; then edit the file as you like.
- The file name carries the id: `US-3-….md` holds `id: US-3`, and it sits in the folder of its epic (`EP-1-…/` and
  `epic: EP-1`). The rest of the name is cosmetic.
- Front matter has exactly the keys `id`, `epic`, `title`, `state` (`draft` or `agreed`) for a story and `id`, `title`
  for an epic. `built` and `verified` are never written: the OS derives them from the tests.
- A story has `## Acceptance criteria` (it may be empty while the story is a draft), one `### AC-<n> <title>` per
  criterion with `- Given`, `- When`, `- Then` lines in that order (`- And` continues the previous keyword), and an
  optional `## Notes` section with free text.
- An epic has its description, then `## Requirements` with `### Technical`, `### UX` and `### Governance`.

A malformed file or an id used twice in a push is refused with the file, the line and the fix. A push that changes a
story is not agreed silently: the OS shows it for review before the app can go live beyond your own scope.

## Example story

```markdown
---
id: US-3
epic: EP-1
title: Submit an order
state: agreed
---
As a **sales rep** I want **to submit an order** so that **the warehouse can ship it**.

## Acceptance criteria

### AC-1 Valid order is accepted
- Given a signed-in sales rep
- When they submit an order with a customer and at least one line
- Then the order is saved with status "new"

## Notes
Free text, never parsed.
```

Tests prove criteria by naming them: `test('[US-3/AC-1] valid order is accepted', …)`. See
[`docs/rules/stories-and-tests.md`](../docs/rules/stories-and-tests.md).
