# git — the system of record

> **Git is the system of record; the OS registry is a derived index plus governance metadata.**
> Everything built in the OS — from the UI, the MCP or Ask the OS — lands in a real git
> repository as a commit authored by the person who made the change. There is no "export to
> git" step and no second ledger.

Two halves, two owners:

- **Versioning** (this document's first half): what lives where, how a version is read back,
  diffed and restored. Owned by the git-objects module in the kernel.
- **Working from VS Code** (the engineer's door): clone, fetch and push over authenticated git
  HTTP. Appended below by that work; nothing here describes it yet.

There is **no new cluster component**: the repositories are bare repos on the `os-repos` PVC,
written in-process by os-ui through `isomorphic-git` (MIT), with a read-only `git daemon`
sidecar and an optional push-mirror. `docs/components/os-ui.md` carries the deployment detail.

## Read is unconditional; write is gated

Anyone with access to a domain can clone and read the **whole** repository — including the
OS-owned governance metadata, which is committed as real files (`os/*.yml`) precisely so that
nothing is a black box. Those files are **not pushable**: the receive gate rejects a change to
them with *"managed by the OS; change it in Governance or over the MCP"*.

Transparency must never require write access, and write access must never be the only way to
see what the OS did.

## The repo layout — one table, authoritative

One bare repo per domain at `$OS_REPOS_DIR/<domain>.git` (default `/repos`), **`main` only**.
This table is mirrored in code as `GIT_OBJECT_LAYOUT` in `os-ui/core/infra/git-objects.ts`, and
the enumeration test `core/infra/git-objects-kinds.test.ts` fails if the two drift or if a new
object kind appears without being classified.

| Object kind | Path in the domain repo | Personal lane | Writer |
|---|---|---|---|
| dbt project (datasets, compositions, quality rules, schedules) | `dbt_project.yml`, `profiles.yml`, `models/**`, `os/schedules.yml`, `os/sources.yml`, `os/external.yml` | `models/personal/<uid>/**` | `tabs/data/lib/dbt/commit.ts` — **committed** |
| metric (dbt `semantic_models` + `metrics`) | `models/semantic/<model>.yml` | `models/personal/<uid>/semantic/<model>.yml` | the dbt commit path; the semantic **emitter** lands with the metrics work |
| dashboard | `dashboards/index.yml`, `dashboards/<slug>/dashboard.yaml`, `dashboards/<slug>/README.md` | `dashboards/personal/<uid>/<slug>/…` | `tabs/dashboards/lib/git/commit.ts` — landing |
| agent system | `agents/index.yml`, `agents/<slug>/{system.yaml,agents/<id>.md,graph.json,README.md}` | `agents/personal/<uid>/<slug>/…` | `tabs/agents/lib/git/commit.ts` — **committed** |
| software app | `apps/<slug>/**` + `apps/<slug>/.app/release.json`; releases as tags `app/<slug>/v<x.y.z>` | n/a (an app is owned, not laned) | `tabs/software/lib/git/commit.ts` — landing |
| lifecycle pins | `os/lifecycle.yml` + tags `live/<kind>/<id>` | — | `core/kernel/lifecycle.ts` — landing |
| promotion / governance metadata | `os/promotion.yml`, `os/grants.yml` | — | OS-owned, **never pushable** |
| knowledge workflow | `knowledge/<slug>/**` | `knowledge/personal/<uid>/<slug>/…` | **backlog** — no git writer yet |
| connection configuration (**never a credential**) | `connections/<slug>.yml` | — | **backlog** — no git writer yet |

A personal lane is one repository convention, not a second repository: a promotion **moves** the
directory out of the lane in the same commit that changes the visibility, and the id in
`index.yml` and in the `OS-Object` trailer is what stays frozen — a directory name is a slug,
not an identity.

## Every commit says who, what, where and why

`core/infra/git-store.ts` writes one subject plus trailers:

```
agents(sales): set schedule cron support — via mcp:commit_agent_files

OS-Action: set schedule cron
OS-Object: sys_7f3a (Support triage)
OS-Surface: mcp:commit_agent_files
OS-Request-Id: req_01J…
OS-Run-Id: run_…           # only when an agent run caused it
OS-Actor: amir             # the principal id, even when the author is a display name
OS-Reason: boot-reconcile  # only when the cause is not a person's action
```

Author = the acting user; committer = `Sovereign OS`. A user without an e-mail address gets
`<id>@os.local` **and** the `OS-Author-Email: synthesized` trailer — never a silent invention.

## Versioning: read unconditional, restore through the writer

`core/infra/git-objects.ts` is the one generic read-back. Every kind answers the same four
questions, and the UI (`core/ui/git/`) and the MCP (`core/mcp/git-tools.ts`) call the **same**
module:

| Function | MCP tool | Answers |
|---|---|---|
| `objectGitInfo(kind, id)` | `get_history` | `{head, history[], truncated, via, paths}` |
| `getVersion(kind, id, sha)` | `get_version` | the object's files exactly as they were at that commit |
| `diffVersions(kind, id, a, b)` | `diff_versions` | a unified diff an engineer could `git apply` |
| `restoreVersion(kind, id, sha)` | `restore_version` | **one new commit** through the object's normal writer |

Four properties worth stating plainly, because each is a decision:

1. **`git.head` is never a wrong `null`.** The lookup keys on the `OS-Object` trailer *and*
   falls back to a path-scoped `git log -- <paths>`. Boot reconciles commit as the platform with
   `OS-Object: <domain>`, so a trailer-only lookup answered `null` for objects that plainly have
   files in the tree. `via` reports which source answered: `trailer`, `path`, `trailer+path` or
   `none`.
2. **The window is bounded and says so.** One domain repo mixes the dbt project, the agent
   systems, the dashboards and every app, so a per-object history scans far more than it
   returns (default: 200 commits scanned, 10 returned, hard ceiling `MAX_LOG_DEPTH` = 2000).
   `truncated: true` means "this is what fitted", never "this is all there is".
3. **Owner/scope gating with one `not_found`.** The owning tab's own governed read decides
   visibility. An object you may not see and an object that does not exist return a
   **byte-identical** `no <kind> '<id>'` — so an id cannot be probed for existence.
4. **A restore is a new commit, never a rewrite.** `restoreVersion` reads the old files and
   hands them to the kind's **normal writer**, so every invariant, validation, approval and
   trailer on the normal path still applies. A kind whose tab has not registered that writer is
   refused with a typed `restore_unsupported`: a partially applied restore is worse than none.
   **The OS never rewrites a human's history** — a push is the authoritative new head, a restore
   is a new commit, and a reconcile that would empty a tree is refused
   (`DestructiveReconcileError`).

### Adding a kind

Four edits, in this order, and the test tells you if you miss one:

1. a row in `GIT_OBJECT_KINDS` + `GIT_OBJECT_LAYOUT` (`core/infra/git-objects.ts`) — declaring
   `committed` (naming the writer module), `landing` (naming the stream) or `backlog` (with a
   reason);
2. the same row in the table above;
3. `registerGitObject('<kind>', resolver)` from the owning tab, called at boot in
   `instrumentation.ts` — the resolver runs the tab's **own** governed read as the caller;
4. optionally `registerGitObjectRestorer('<kind>', writer)` to make restore available.

`core/infra/git-objects-kinds.test.ts` fails when a module imports `commitTree`/`commitSubtree`
and no kind claims it, so a new writer cannot be added without classifying it.

### What is NOT true yet

- **Restore is wired for no kind yet.** The gate, the refusals and the "new commit, through the
  writer" contract are implemented and tested; no tab has registered a restorer, so
  `restore_version` answers `restore_unsupported` for every kind today. The UI's
  "Restore this version" button surfaces exactly that refusal rather than hiding it.
- **Knowledge workflows and connection configurations are not in git at all** — see the table.
- **Releases** (`app/<slug>/v<x.y.z>` tags) are read by `ReleaseList` only once the tag API in
  `core/infra/git-store.ts` lands; until then the release panel is hidden rather than empty.
- **Conflicts resolve at the git level** — last writer wins. There is no OS-level merge.

## Commands an engineer would run

```bash
# the whole domain repo, read-only, from inside the cluster
git clone git://os-ui.agentic-os.svc.cluster.local/<domain>.git

# what the OS says, by hand
git log --oneline -- agents/<slug>/            # the per-object history
git show <sha>:agents/<slug>/system.yaml       # one version of one file
git diff <a> <b> -- agents/<slug>/             # the diff the drawer renders

# the native export (dbt accepts it as a project)
curl -s .../api/data/project/<domain>/archive | tar -xz -C /tmp/<domain> && dbt parse
```
