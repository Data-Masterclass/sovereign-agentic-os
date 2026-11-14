<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->

# git — the system of record

Git is not a feature of this OS; it is where the OS keeps everything it builds. One **bare
repository per domain** lives on the `os-repos` volume (`<OS_REPOS_DIR>/<domain>.git`, default
`/repos`). Every dataset, composition, quality rule, schedule and agent system is a file in it, and
every mutation — from the UI, from the OS MCP, or from Ask the OS — is a real commit authored by the
person who made it.

> **The coin.** One side is an engineering coin: clone the domain repo, edit a dbt model or a
> `system.yaml`, push, and the OS validates it with the same code the UI uses and reconciles its
> registry from the files. The other side is a business-user coin: fill in a form, ask for a
> dashboard, click promote — and the OS writes the same files to the same repo through the same
> commit path. **It is the same coin.**

Two rules follow, and they are the ones to remember:

- **A file is authoritative; a registry row is a cache of it.** Where the two disagree, the file
  wins and the row is re-derived.
- **Read is unconditional; write is gated.** Anyone with access to a domain can clone and read the
  **whole** repository — including the OS's own governance metadata under `os/` — because nothing
  the OS does should be a black box. Those files are *not* pushable.

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
