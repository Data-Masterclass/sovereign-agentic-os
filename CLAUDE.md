# CLAUDE.md — sovereign-agentic-os

Loaded at the start of every session. **If it must be followed, it lives in a file; if it must
never break, it fails a check.** Chat instructions are suggestions; these files, the hooks and
CI are law.

## Read these first — they are the rules, for everyone

- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — the repository structure, the closed set of 13 tab
  modules, the three import rules, bundled-component policy, the checks to run, and the
  operating rules for deploys. This is the source of truth; it is deliberately written for
  human contributors rather than for one tool.
- **[`os-ui/ARCHITECTURE.md`](os-ui/ARCHITECTURE.md)** — how the kernel and tabs fit together,
  and "Things this codebase will punish you for": the constraints that have each cost real
  debugging time.

Nothing from those files is duplicated here. Duplicated rules drift, and the copy in the
tool-specific file is the one that goes stale.

## Session discipline — the chat is disposable, the repo is the memory

- **One session per task.** Start by stating the brief. The design docs,
  `docs/superpowers/plans/` and git history are the project memory.
- **Safe to clear when** the work is committed **and** the decisions are recorded in a doc.
  **Not safe** while reasoning exists only in the chat — commit first, then write the open
  items and current state into the relevant doc.
- Long sessions degrade and auto-compact. Finish the task, record it, clear, start fresh.
- Use plan mode for anything touching multiple files; the plan must say which files go where.
- **End-of-task ritual:** record learnings in `os-ui/ARCHITECTURE.md` or the relevant
  `docs/components/*.md` → commit → clear.

## Enforcement

`scripts/check-structure.mjs` runs as a PostToolUse hook on Write|Edit
(`.claude/settings.json`), so a structure violation surfaces in-session rather than at CI. It
also runs in CI. Surgical changes only; a periodic pass is *"list and fix every violation of
CONTRIBUTING.md's structure rules — nothing else."*
