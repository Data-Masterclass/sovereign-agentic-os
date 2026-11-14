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
| `dataset` — dbt project (datasets, compositions, quality rules, schedules) | `dbt_project.yml`, `profiles.yml`, `models/`, `os/schedules.yml`, `os/sources.yml`, `os/external.yml` | `models/personal/<uid>/` | `tabs/data/lib/dbt/commit.ts` — **committed** |
| `metric` — dbt `semantic_models` + `metrics` | `models/semantic/<model>.yml` | `models/personal/<uid>/semantic/<model>.yml` | `tabs/data/lib/dbt/commit.ts` — **committed** |
| `dashboard` — dashboard-as-code | `dashboards/index.yml`, `dashboards/<slug>/` | `dashboards/personal/<uid>/<slug>/` | `tabs/dashboards/lib/git/commit.ts` — **committed** |
| `agent-system` — LangGraph system | `agents/index.yml`, `agents/<slug>/` | `agents/personal/<uid>/<slug>/` | `tabs/agents/lib/git/commit.ts` — **committed** |
| `software` — app source tree | `apps/<slug>/` | — | `tabs/software/lib/git-commit.ts` — **committed** |
| `lifecycle-pin` — lifecycle pins | `os/lifecycle/pins.yml` | — | `core/infra/lifecycle-pins.ts` — **committed** |
| `knowledge-workflow` — knowledge workflow | `knowledge/<slug>/` | `knowledge/personal/<uid>/<slug>/` | **backlog** — no git writer yet |
| `connection-config` — connection configuration (**never a credential**) | `connections/<slug>.yml` | — | **backlog** — no git writer yet |
| *(not an object kind)* promotion / governance metadata | `os/promotion.yml`, `os/grants.yml` | — | OS-owned, **never pushable** |

The paths are **selectors**, exactly as the code states them: `a/b/` means everything under that
directory, `a/b.yml` one file. What a selector contains is the owning writer's business — a
dashboard directory holds `dashboard.yaml` and `README.md`, an agent-system directory holds
`system.yaml`, `agents/<id>.md`, `graph.json` and `README.md`, an app directory holds the app's
whole source tree. The first column's backticked token is the `GitObjectKind`, and
`core/infra/git-objects-kinds.test.ts` parses this table and deep-equals it against
`GIT_OBJECT_LAYOUT`, so a row here cannot drift from the code.

**No tags.** Neither a release tag (`app/<slug>/v<x.y.z>`) nor a live tag (`live/<kind>/<id>`) is
written by anything today — `annotatedTag` landed in `core/infra/git-store.ts` with no caller, and
`core/kernel/go-live.test.ts` asserts `tag.written === false`. The paths above are the whole truth.

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
| `restoreVersion(kind, id, sha)` | *(not on the MCP surface yet)* | **one new commit** through the object's normal writer |

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

### The operator-surface rule

Two surfaces in `/api/git` are **tenant-wide and unscoped by domain**: `?action=repos` (every
repository, with its mirror URL and its push errors) and `?action=repolog&domain=…` (one
repository's commit log, whose subjects carry each object's slug — which for a Personal object is
somebody's own artefact name). Both are therefore **admin-only**, the same floor Platform →
Components applies to the same material, and Governance → Repositories is an admin-only section.

The commit log carries a **second, independent gate** on top of the role: a row appears only when
its `OS-Object` trailer resolves — through the owning tab's own governed read, as the caller — to
an object that caller may see. Rows that do not resolve are **counted and reported**
(`hidden`, with a reason), never silently dropped, and a kind whose resolver is not registered yet
counts as not resolvable: this surface fails closed.

### Secrets, binary blobs and size

A version read is the one path that hands raw repository bytes to a browser or an AI client, so:

- **Secret-shaped content is redacted** before it leaves the server — `password:`/`token:`/
  `api_key:`-style values, PEM private keys, credentials inside URLs, and provider key formats
  become `***REDACTED-BY-OS***`. `redacted` / `redactedPaths` say which files were altered and by
  which pattern. The scrub is deliberately **not** an entropy heuristic: a commit sha, a blob oid
  and a UUID are all high-entropy and must survive untouched. A **restore re-applies the raw
  bytes**, never the redacted ones — the scrub lives at the read-out boundary, not in the
  primitive.
- **A diff compares the raw bytes** and only then redacts, so a change that is entirely inside
  redacted content is reported as a redacted change rather than as "no change".
- **Binary blobs are named, never decoded.** A binary file comes back with `binary: true`, its
  size, and an empty `content`; a diff shows git's own `Binary files … differ`. A version
  containing one **cannot be restored** (`binary_in_version`): re-applying an empty content would
  truncate the file.
- **A version read is bounded in files and in bytes** (`MAX_VERSION_FILES`, `MAX_VERSION_BYTES`),
  and `truncated` / `truncatedBy` say which limit was hit.

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

- **`restore_version` is not an MCP tool yet.** A write tool must be declared in the governed
  write catalogue (`core/mcp/write-tools.ts` + `core/mcp/write-tool-meta.ts`), and today its only
  possible answer is `restore_unsupported`; it is one row in two files once a kind registers its
  writer. The function, the gate and the refusals exist and are tested.
- **Restore is wired for no kind yet.** The gate, the refusals and the "new commit, through the
  writer" contract are implemented and tested; no tab has registered a restorer, so
  `restoreVersion` answers `restore_unsupported` for every kind today. The UI's
  "Restore this version" button surfaces exactly that refusal rather than hiding it.
- **Knowledge workflows and connection configurations are not in git at all** — see the table.
- **Releases** (`app/<slug>/v<x.y.z>` tags) are read by `ReleaseList` only once the tag API in
  `core/infra/git-store.ts` lands; until then the release panel is hidden rather than empty.
- **Conflicts resolve at the git level** — last writer wins. There is no OS-level merge.
- **A rename or a lane move hides the OLD path from the path fallback** (backlog). A resolver
  derives its selectors from where the object lives *now*, so commits made under a previous
  directory are found only by the `OS-Object` trailer — which is the identity, so a user's own
  history stays complete; what can be missing is the old-path part of a *platform-attributed*
  history (a boot reconcile made before a rename). The fix is a path history (`--follow`-style, or
  previous paths recorded in `index.yml`). Until then `via` reports how the answer was found and
  `truncated` never claims completeness.
- **The kinds test pins today's classification on purpose.**
  `core/infra/git-objects-kinds.test.ts` asserts that exactly `dataset`, `metric`, `dashboard`,
  `agent-system`, `software` and `lifecycle-pin` are `committed`, that nothing is `landing`, and
  that `knowledge-workflow` and `connection-config` are the honest backlog. The same file parses
  the layout table above and deep-equals it against `GIT_OBJECT_LAYOUT`, so when a stream lands a
  writer, flip the kind's row in the code table, move its name in the test's lists, and correct
  the row above — in whichever order; the test failing is the reminder, not a defect.

## The surfaces

| Surface | Where | What it shows |
|---|---|---|
| `GitHeadBadge` | `os-ui/core/ui/git/GitHeadBadge.tsx`, mounted as ONE line in a detail header | `git <sha7> · <author> · <when>`; the tooltip carries the full sha, the action, the surface, the actor and the `git log --` command |
| `HistoryDrawer` | `os-ui/core/ui/git/HistoryDrawer.tsx` (the badge opens it) | the commit list with action / actor / surface, the per-commit unified diff against the current version, and the restore confirm |
| `ReleaseList` | `os-ui/core/ui/git/ReleaseList.tsx` | an app's release tags — **hidden entirely** while the annotated-tag API is absent |
| Governance → Repositories | `os-ui/tabs/governance/ui/RepositoriesView.tsx` | per-domain head, commit count, last author, mirror status and the layout table |
| `/api/git` | `os-ui/app/api/git/route.ts` | `?action=history\|version\|diff\|releases&kind=&id=` and `?action=repos`; POST `{kind,id,sha}` restores |

All of the logic is in `os-ui/core/ui/git/git-view.ts` (a test cannot import a `.tsx`), including
the badge's three empty states — "not in git", "no commit yet", "no repository yet" — which exist
so the absence of a version is never shown as a version.

The mount is one line and the tabs own nothing else about git:

```tsx
<GitHeadBadge kind="dataset" id={dataset.id} />
```

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

<!-- NIGHT-2 MERGE: the second half, appended by stream E exactly where the first half says it
     will be. E's own copy of the SPDX header, the H1 and the "system of record" preamble is
     dropped as a duplicate of the first half above; its two rules are already stated there
     ("Read is unconditional; write is gated"). Nothing of E's own content is removed. -->

---

## Work from VS Code

### 1. Create a personal access token

**Platform → Access tokens → Create token.** Give it a name you will recognise ("laptop", "CI").

The token is shown **once**. It is stored **hashed** (SHA-256 of the whole token; the secret half is
256 bits of `crypto.randomBytes`, so there is nothing to grind and a slow KDF would only tax every
`git push`). Afterwards the list shows its prefix — `sos_a1b2c3d4e5f6_…` — its name, when it was
created, when it expires and when it was last used. Nothing can show you the token again.

A token:

- acts as **exactly one** OS identity — yours — and carries **no** authority of its own. Your role
  and your domains are re-read live on every request, so a demotion or an offboarding takes effect
  on the next command, not on the next token;
- is **revocable** from the same screen, and stops working immediately;
- expires (365 days by default);
- is **never logged, never echoed in an error and never committed.** Server-side logs name only the
  prefix.

### 2. Clone

```sh
git clone https://<os-host>/git/<domain>.git
# username: anything (it is ignored)   password: your OS access token
```

The remote is always **HTTPS** (the OS will not print a plain-`http` remote except on loopback: the
token travels in the request). The component that shows this command on a detail page —
`core/ui/git-clone/CloneRepository.tsx` — exists and is tested, but is **not mounted on any page
yet**: the detail pages belong to the engineering-view and git-UI streams, and they mount it.

You get the whole tree, including:

| Path | What it is |
|---|---|
| `dbt_project.yml`, `profiles.yml`, `macros/`, `tests/generic/` | the domain's dbt project, exactly as `dbt parse` wants it |
| `models/<layer>/` | promoted (domain) layers |
| `models/personal/<you>/` | your own personal lane |
| `models/**/schema.yml` | descriptions and the quality rules, as dbt tests |
| `agents/<slug>/`, `agents/personal/<token>/<slug>/` | agent systems (`system.yaml`, `AGENT.md`, the compiled graph) |
| `agents/index.yml` | slug → the system's frozen OS id |
| `os/*.yml` | **the OS's own metadata** — schedules, grants, promotion state, rules |

`os/` is readable on purpose. Transparency must never require write access.

To run the project the way the OS does:

```sh
export TRINO_HOST=trino TRINO_PORT=8080 TRINO_USER=dbt-runner OS_PRINCIPAL=<your-principal>
dbt parse --profiles-dir .
dbt build --profiles-dir . --select <model>+
```

### 3. Push

```sh
git push origin main
```

What happens, in order:

1. **The ingress authenticates you.** Every `/git/**` request is authorised by a sub-request to the
   OS (`/api/git/authenticate`) before it reaches the git transport. No token, an expired one or a
   revoked one is a `401`; a domain you are not a member of is a `404` (naming it would tell a
   stranger it exists).
2. **The OS takes the repository's lock.** The `pre-receive` hook calls **one** OS endpoint
   (`/api/git/receive`), which holds the **same per-domain lock** the OS's own commit path uses, for
   the duration of `receive-pack`. An OS write and your push cannot interleave. If the OS is
   mid-write, your push waits — bounded — and then fails with a sentence telling you to try again.
   It never hangs your terminal.
3. **Fast-forward only.** A non-fast-forward push to `main`, or a deletion of it, is refused. The OS
   never rewrites a human's history and never accepts a rewrite of it either.
4. **Path ownership.** Your own personal lane is always yours. Shared domain paths need `builder` or
   above. Someone else's personal lane is never writable, whatever your role. And `os/*`,
   `agents/index.yml`, grant files and anything credential-shaped are refused with
   *"managed by the OS; change it in Governance or over the MCP"*.
5. **The same validators the UI and the MCP call.** `agents/**/system.yaml` goes through
   `parseSystem` — literally the function the agent builder's Save calls. `models/**/schema.yml` and
   every `.sql` model go through the dbt gate: valid YAML, `version: 2`, and a model or column name
   dbt can actually resolve (an unresolvable name fails `dbt parse` for the *whole* domain, not just
   your file, which is why it is refused at the door).
6. **A rejection is a readable message on your terminal**, naming the file and the reason.

### 4. What the OS does afterwards

The `post-receive` hook calls the same endpoint, which reconciles the registry **from the files**:

| You pushed | The OS updates |
|---|---|
| `models/**/schema.yml` | the dataset: name, layer, schema, columns, description, and the quality rules derived from the dbt tests |
| `agents/**/system.yaml` | the agent system definition, with a new version in its history |

The registry write is attributed to **you**, with the commit trailer `OS-Surface: git:push` — so the
history reads honestly, and a change made by a push is distinguishable from the same change made in
the UI (`ui:<route>`) or over the MCP (`mcp:<tool>`) *only* by that trailer. That is the coin test,
and it runs in CI.

A new model becomes a Dagster asset through the existing repo-sync + reload path — there is no
second mechanism.

Things the OS deliberately will **not** infer from a push:

- deleting a file does **not** delete the object. Retirement is a governed action with its own
  dependents check; the OS says so and leaves the object alone.
- a push never changes an object's **audience**. A system an engineer creates by pushing is
  `My` / Personal. `My → Domain → Company` is a promotion, with its approvals.
- a `relationships:` test becomes an OS `reference` rule only when the referenced **dataset** can be
  resolved; otherwise the OS reports it rather than guessing an id.

### What is read-only, and why

| Read-only | Why |
|---|---|
| `os/*.yml` | the OS's own record of schedules, grants and promotion state. It is committed so you can *audit* it; editing it in git would mean two writers for one fact. Change it in Governance or over the MCP. |
| `dbt_project.yml`, `macros/**`, `profiles.yml`, `packages.yml` | dbt **executes** these as the OS's dbt principal on every build — `on-run-start:` SQL, every macro a model calls, the connection, a package fetch. A model *selects*; these *run*. Changing them is a change to what the OS runs, so it goes through the OS. |
| `agents/index.yml` | the slug → identity map. A directory name is not an identity, and rewriting identities is not something a push may do. |
| anything credential-shaped | a credential has no business arriving by push. Connections hold secrets by reference; `profiles.yml` reads environment variables only. |
| someone else's `models/personal/…` or `agents/personal/…` | a personal lane is the one place the OS promises is yours. |

Two more refusals, for the same reason — the registry is derived from the files, so a file must
never be able to say something only a governed action may say:

| Refused | Why |
|---|---|
| a push that **empties an object's directory** (every file under `dashboards/<id>/`, `agents/<slug>/`, or a whole kind) | retiring an object is a governed action with a dependents check. `git rm -r` is not it. This is the same rule the boot reconcile applies to itself. |
| a pushed **`tier` / `visibility`** that disagrees with the registry | `My → Domain → Company` changes only through promotion, with its roles and approvals. The field is in the file so the file is self-describing; the OS owns the value. Make the value agree, or promote in the OS. |

Each is one sentence on your terminal naming the file.

### Troubleshooting

| What you see | What it means |
|---|---|
| `fatal: Authentication failed` | no token, wrong token, expired or revoked. Create a new one in Platform → Access tokens. |
| `remote: '…' is managed by the OS; change it in Governance or over the MCP` | you changed a file the OS owns. Drop that file from the commit. |
| `remote: this push is not a fast-forward of main` | rebase onto the current `main` and push again. The OS never accepts a rewrite. |
| `remote: the OS is writing to '<domain>' right now…` | an OS write held the lock longer than the bounded wait. Nothing changed; push again. |
| `remote: dataset: 0 created, 0 updated` | the push landed but nothing in it maps to an OS object (for example a `.sql` change with no `schema.yml`). The files are stored; the registry is unchanged by design. |
| `remote: '…/' would be emptied by this push` | you removed every file of an object. Retire it in the OS instead, or keep at least the file that defines it. |
| `remote: audience is managed by the OS; use promotion` | the file's `tier`/`visibility` disagrees with the OS. Set it back to what the OS holds and promote there. |
| `remote: '…' is …; this door accepts files up to 1048576 bytes` | a large (usually binary) file. A domain repository holds definitions, not artefacts. |

### How it is served

`git clone` and `git push` are served by **git's own `git-http-backend`** CGI — the OS writes no git
protocol — behind lighttpd in `images/base/git-http`, as a separate non-root process in a sidecar on
the os-ui pod with the `os-repos` volume mounted. Authentication is the OS's (`auth-url` to
`/api/git/authenticate`), not the transport's, and the `NetworkPolicy` admits port 9419 from the
ingress controller only. `git` is GPL-2.0, `lighttpd` BSD-3-Clause and `curl` MIT-like: all three are
distro packages run as separate processes, and nothing links to our code.

Build the image with:

```sh
docker build -t ghcr.io/aborek/sovereign-os/git-http:1.0.0 images/base/git-http
# kind: kind load docker-image ghcr.io/aborek/sovereign-os/git-http:1.0.0 --name <cluster>
```

The build **fails** if `git-http-backend` or lighttpd's `mod_cgi` is missing from the distro
packages — the same guard `images/base/git-daemon` carries, for the same reason: the first rollout
of the read-only git daemon crash-looped because a stock image silently omitted the binary.

**Who reads the pushed objects.** During `pre-receive`, git keeps the incoming objects in a
**quarantine** directory (`GIT_QUARANTINE_PATH`) that only the hook's own process tree can see. So
the hook — not the OS — computes the fast-forward verdict and the change list, with git's own
plumbing (`git merge-base --is-ancestor`, `git diff-tree -r --name-status`, `git cat-file blob`),
and posts them. The OS reads nothing from the repository until `post-receive`, when the refs are
updated and the objects are real; then it re-derives the change list **from the repository** and
reconciles from that. The hook gates; the repository is the record.

### Two operational caveats, said plainly

- **`kubectl port-forward` goes around the NetworkPolicy.** The policy admits port 9419 from the
  ingress controller only, and the Ingress is where the OS's authentication sub-request runs — so a
  port-forward to the pod reaches `git-http-backend` with **no authentication in front of it** and
  can read every domain repository. That is a cluster-admin capability (`pods/portforward`), and
  anyone who has it can read the PVC anyway; but it means repository read access is **not** limited
  to token holders for operators. Treat `pods/portforward` in the OS namespace as equivalent to
  read access to every domain's files.
- **With `ingress.enabled=false` (the bundled / local profile) there is no authentication at all in
  front of the sidecar.** Nothing outside the cluster can reach it, and the NetworkPolicy admits
  only the ingress namespace — which does not exist on that profile — so in practice the port is
  reachable only from inside the pod. The push path authenticates itself either way (the hook
  forwards the token and the OS re-resolves it), but the **read** path on that profile is protected
  by the network, not by a credential.

### What is NOT true yet

- **Branches are not proposals.** `main` is the only ref this server accepts. A `proposal/*` branch
  surfacing as a promotion request, and PR-like review in the UI, are not built.
- **Only two kinds map back.** Datasets (via `schema.yml`) and agent systems (via `system.yaml`).
  Metrics, dashboards and software apps are written *to* git by the OS but a push of them changes
  the files only — the registry is not yet derived from them. Each kind joins through the same
  `ingestFromRepo(kind, files)` contract, and that contract has two obligations every kind owes:
  **never apply audience** (a disagreeing `tier`/`visibility` refuses the path) and **never
  retire** (a removed file is reported; a wholesale removal is refused by the gate before the
  ingest runs).
- **The dbt gate is not `dbt parse`.** There is no dbt in the os-ui process. The gate checks what
  can be checked per file — valid YAML, `version: 2`, a `models:` list, and a model or column name
  dbt can resolve (the invariant whose violation breaks the *whole* project). A `ref()` to a name
  that does not exist is found by Dagster's own `dbt parse` on the pushed commit, not at the door.
- **A push does not build.** It updates the definition. The physical build is Dagster's, from the
  same commit.
- **The live clone and push are verified in the cluster, not in CI.** Everything above is covered
  offline by a fake receive (a real bare repo in a temp dir, a synthetic push, the endpoint called
  directly); the real HTTPS round trip is a deploy-time check.
