# CI image builds, and a deploy that needs no local Docker — 2026-11-19

**Branch** `feat/ci-image-builds` (from `public/main` @ `7c45bd95`) · **PR to** `main` · no merge,
no deploy, no tag push.

## Why

Every image this project has ever shipped was built on the owner's Mac through Colima: a 14 GB
VM on a 24 GB host, driven by `scripts/deploy.sh <version>` (`docker build --platform
linux/amd64 … && docker push`, then one `helm upgrade`). That has cost real outages and real
hours:

- the Colima VM's DNS failed **twice** mid-build, so the build died after the backup gate had
  already run;
- the host **OOM-killed** runs — which is why `CONTRIBUTING.md` carries "Stop Colima after
  building"; left running it starves the very `kubectl` and `helm` calls the same deploy needs;
- an emulated amd64 build takes 10–15 minutes and **blocks the machine** for all of it. The
  existing `SKIP_BUILD=1` escape hatch exists only because runs died *after* the build.

GitHub's runners are amd64 natively, have a cache, and are not the owner's laptop. So: build in
CI, and give `deploy.sh` a mode that **pulls a tag that already exists** instead of making one.

## The namespace problem — the ONE thing the owner must decide

Images live at `ghcr.io/aborek/sovereign-os/{os-ui,git-http,git-daemon,dagster,minio}`, but the
repository is `Data-Masterclass/sovereign-agentic-os`. A workflow's built-in `GITHUB_TOKEN`
can push to `ghcr.io/data-masterclass/*` and **cannot** push to the `aborek` user namespace.
The repo has **no Actions secrets today** (`gh api
repos/Data-Masterclass/sovereign-agentic-os/actions/secrets` → empty).

Two ways out, and this plan refuses to choose for the owner:

| | Option A — move the namespace | Option B — keep `aborek`, add a PAT |
|---|---|---|
| registry prefix | `ghcr.io/data-masterclass/sovereign-os` (the workflow default) | `ghcr.io/aborek/sovereign-os` |
| secret needed | **none** | `GHCR_TOKEN` (classic PAT, `write:packages`) |
| repo variable | none | `IMAGE_REPO_PREFIX=ghcr.io/aborek/sovereign-os` |
| cluster image access | the new package must be readable by the existing `ghcr.io` credential (or public) | unchanged |

So the workflow is written so that **neither choice changes production until the owner flips one
value**: the push target is
`${{ vars.IMAGE_REPO_PREFIX || 'ghcr.io/data-masterclass/sovereign-os' }}` and login uses
`secrets.GHCR_TOKEN` when it exists, else `GITHUB_TOKEN`. Nothing in this branch pushes an
image, moves a tag, or alters a running release.

## Deliverables, one commit per phase

### 1 · `.github/workflows/build-images.yml` (new)

- **Triggers:** `push` of tags `os-ui-v*`, `git-http-v*`, `dagster-v*`; plus
  `workflow_dispatch` with inputs `image` (choice: os-ui · git-http · git-daemon · dagster) and
  `version` (string).
- **Resolve:** a tag `os-ui-v0.9.0` → image `os-ui`, version `0.9.0`. Dispatch takes the inputs
  verbatim. One step writes `image`, `version`, `ref` to `$GITHUB_OUTPUT`.
- **Dockerfile + context per image** — these differ, and getting them wrong is a silent failure:

  | image | dockerfile | context |
  |---|---|---|
  | `os-ui` | `images/base/os-ui/Dockerfile` | `.` (repo root — the image bakes in `docs/components/*.md`) |
  | `git-http` | `images/base/git-http/Dockerfile` | `images/base/git-http` (COPYs `lighttpd.conf`) |
  | `git-daemon` | `images/base/git-daemon/Dockerfile` | `images/base/git-daemon` |
  | `dagster` | `images/extensions/dagster/Dockerfile` | `images/extensions` (COPYs both `dagster/` and `dbt/`) |

  The table is lifted from `scripts/os` (`$IMAGES`), which is the only place today that knows it.
- **Build:** `docker/setup-buildx-action` + `docker/build-push-action`, `platforms:
  linux/amd64`, `provenance: false`, `cache-from/to: type=gha`. `--provenance=false` is not
  cosmetic: a provenance attestation turns the pushed tag into a manifest LIST, and
  `docker inspect`'s `RepoDigests[0]` then yields the attestation index rather than the image —
  which is the digest `deploy.sh` pins. Same flag `deploy.sh` already passes.
- **os-ui smoke before the push:** load the image locally first (`load: true`, no push), then run
  the **byte-for-byte** smoke from `scripts/deploy.sh` — `node --experimental-strip-types
  --no-warnings --input-type=module -e "… register('./worker/resolve-hook.mjs' …);
  await import('./worker/agent-runs.ts') …"` — and only then push. The `os-ui-worker` container
  runs the TypeScript SOURCE under Node's type stripping; no unit test can see a base-image bump
  below Node 22.6 or a broken resolve-hook alias, and the failure mode is
  `ERR_UNKNOWN_FILE_EXTENSION` at boot, *after* the deploy. Two build calls, one cache.
- **Permissions:** `packages: write`, `contents: read`.
- **Outputs:** the pushed digest as a job output (`digest`) and in `$GITHUB_STEP_SUMMARY`,
  together with the exact `deploy.sh --from-registry` command to run next.

### 2 · `scripts/deploy.sh` — `--from-registry`

New flags, parsed before the positional version (which stays `$1`):

- `--from-registry` / `IMAGE_FROM_REGISTRY=1` — **skip build and push**; instead verify the tag
  exists in the registry and read its digest from there.
- `IMAGE_REPO=<repo>` — the os-ui image repository. Default **unchanged**:
  `ghcr.io/aborek/sovereign-os`. When given, deploy.sh also `--set`s
  `osUI.image.repository`, next to the existing `osUI.image.tag` — today only the tag is set, so
  a new namespace could not be reached at all.
- `--verify-only` / `IMAGE_VERIFY_ONLY=1` — resolve the ref, prove it exists, print the digest,
  exit 0. Touches no cluster. This is also what makes the mode testable.
- `--help` — usage, every flag, and both owner options. Exit 0.
- `DEPLOY_REGISTRY_PROBE=<cmd>` — override the digest probe (`<cmd> <ref>` must print a
  `sha256:…`). Exists for the shell test; also an escape hatch on a machine with no tool.

**Why a probe and not `docker manifest inspect`:** the whole point of the mode is that Docker is
not running. `docker manifest inspect` needs a daemon. So, in order: `crane digest`, then
`skopeo inspect --format '{{.Digest}}'`, then the GHCR v2 API over plain `curl` — fetch a pull
token from `https://ghcr.io/token?scope=repository:<path>:pull` (basic-authed with
`gh auth token` when `gh` is logged in, anonymous otherwise), then `HEAD` the manifest and read
`Docker-Content-Digest`, accepting both the OCI index and the v2 manifest media types.

Everything else stays **exactly** as today and in the same order: context check → values
derivation from the live release (including the night-1 "chart owns the tag, the operator owns
the repository" carry-over, untouched) → the deletion/stateful diff → the pre-upgrade backup
gate (still aborts the deploy) → `helm upgrade … --set osUI.image.tag="$VERSION@$DIGEST"
--force-conflicts --skip-schema-validation --timeout 20m` → rollout → verify. `SKIP_BUILD=1`
keeps working untouched.

### 3 · `os-ui/scripts/gate.sh` + `scripts/check-structure.mjs` — conflict copies, widened

The gate's cloud-sync check catches only `-type f -name '* 2.*'`. It therefore misses exactly the
shapes that hurt most:

- a **directory** — `os-ui/node_modules 2`, `tabs/data 2` — whose contents then get type-checked
  and COPYed into an image;
- a **symlink** named `* 2`;
- an extension-less file: `Dockerfile 2`, `gate 2`.

Widened to `\( -name '* 2' -o -name '* 2.*' \)` over files, directories and symlinks, pruning
descent into a match so a duplicated `node_modules 2` is reported **once** rather than ten
thousand times. `scripts/check-structure.mjs` gains a second, hard door —
`CLOUD-SYNC-DUPLICATE`, scoped to `os-ui/`, `charts/`, `scripts/`, `docs/` and never
descending into `node_modules`/`.next` — so the rule holds even when the gate is not the thing
being run (check-structure is also the PostToolUse hook, so a duplicate surfaces in-session).
The rule is not in the baseline, so any count above zero fails.

`CONTRIBUTING.md` gains a short **"Images: build in CI"** section: both options as copy-paste
blocks, and the two deploy commands.

### 4 · Tests

- `bash -n` on `scripts/deploy.sh`, `os-ui/scripts/gate.sh` and the new test script.
- `scripts/tests/deploy-from-registry.test.sh` — new, self-contained, no Docker, no network:
  `--help` exits 0 and names `--from-registry`, `--verify-only`, `IMAGE_REPO`; a
  `--verify-only --from-registry` run against a **fake** `DEPLOY_REGISTRY_PROBE` prints the
  right ref and digest; a probe that fails makes deploy.sh exit non-zero; `IMAGE_REPO` changes
  the ref; and a gate self-test that creates `docs/.gate-selftest 2/` + a `* 2.*` stray, asserts
  the widened check **fails**, then removes them and asserts it passes again.
- YAML validation per workflow file:
  `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))"` — `act` is not installed and
  is not worth a 300 MB download for a syntax check.
- Then the standing gates: `bash os-ui/scripts/gate.sh`, `node scripts/check-structure.mjs`
  (≤ 419 / 1 / 200 / 1235), `helm lint charts/sovereign-agentic-os -f values.local.yaml`.

## Out of scope, deliberately

- Choosing the namespace, creating the PAT, or setting any Actions secret or variable.
- Pushing a tag, running the workflow, deploying anything, merging anything.
- `minio` — mirrored upstream, no Dockerfile in this repo, so there is nothing to build.
- Multi-arch. The cluster nodes are amd64; an arm64 variant is a cost, not a feature.
- Retiring the local build path. `deploy.sh <version>` with no flag behaves exactly as today.

## Open items for the owner

1. **Pick A or B.** Until then CI pushes to `ghcr.io/data-masterclass/sovereign-os` and the
   cluster still pulls `ghcr.io/aborek/sovereign-os` — i.e. nothing changes by accident.
2. Under option A a `dockerconfigjson` pull secret is keyed by registry HOST, so it needs no
   re-pointing — but `GITHUB_TOKEN` creates the package PRIVATE and repo-scoped, so the
   `data-masterclass` package must be made public or readable by the account behind the
   cluster's existing `ghcr.io` credential. The other images stay in `ghcr.io/aborek`, so one
   credential must read both namespaces for as long as that is true.
3. `git-daemon` has no tag trigger (it changes almost never); it is dispatch-only. Add
   `git-daemon-v*` if that stops being true.

---

## Design — the exact shapes (phase DESIGN, 2026-11-19)

Everything below is the contract the IMPLEMENT commit must satisfy. Written out first because
three of these four pieces have a failure mode that is silent, and one touches a production
deploy path.

### A · `build-images.yml` — the resolve step is the whole design

```
on:
  push:    tags: [os-ui-v*, git-http-v*, dagster-v*]
  workflow_dispatch:
    inputs: { image: choice(os-ui|git-http|git-daemon|dagster), version: string }

permissions: { contents: read, packages: write }

jobs.build:
  outputs: { image, version, ref, digest }
  steps:
    resolve  -> image, version, dockerfile, context, ref       (id: meta)
    checkout
    buildx
    login    -> ghcr.io, username github.actor,
                password ${{ secrets.GHCR_TOKEN || secrets.GITHUB_TOKEN }}
    build-load (os-ui only, push:false load:true)    \_ one buildx cache,
    smoke      (os-ui only, the deploy.sh command)   /  two calls
    build-push (push:true, provenance:false, platforms linux/amd64, cache type=gha)
    summary  -> digest + the deploy command
```

`secrets.GHCR_TOKEN || secrets.GITHUB_TOKEN` is the one trick that lets both owner options
live in one file: in a `${{ }}` expression an **unset secret is the empty string**, which is
falsy, so the `||` falls through to the built-in token. No `if:`, no second job, no error when
the secret does not exist. `vars.IMAGE_REPO_PREFIX` behaves the same way, hence
`${{ vars.IMAGE_REPO_PREFIX || 'ghcr.io/data-masterclass/sovereign-os' }}`.

Resolve, in shell, because a matrix cannot express "one of four, chosen by the tag":

| input | image | version |
|---|---|---|
| `GITHUB_REF_NAME=os-ui-v0.9.0` | `os-ui` | `0.9.0` |
| `GITHUB_REF_NAME=dagster-v1.2.3` | `dagster` | `1.2.3` |
| dispatch `{image: git-http, version: 1.0.1}` | `git-http` | `1.0.1` |

Split on the LAST `-v`, so a hypothetical `os-ui-v2-v0.9.0` still resolves. Then the
image name is looked up in a `case` that also yields the dockerfile and the context —
and **exits 1 on an unknown image**, so a typo'd dispatch fails instead of building
something arbitrary. `version` is refused unless it matches
`^[A-Za-z0-9][A-Za-z0-9._-]*$` (a Docker tag), which also keeps a dispatch input out of
the shell.

Actions are pinned to commit SHAs, as `ci.yml` already does:
`actions/checkout`, `docker/setup-buildx-action`, `docker/login-action`,
`docker/build-push-action`.

The smoke runs **before** the pushing build so a broken worker graph never reaches the
registry. Because buildx caches to `type=gha`, the second call is a cache hit and costs
seconds — the alternative (`push` then test then try to un-push) does not exist in a registry.

### B · `deploy.sh` — the contract

```
usage: deploy.sh [--from-registry] [--verify-only] [--help] <version>

env    IMAGE_FROM_REGISTRY=1     same as --from-registry
       IMAGE_VERIFY_ONLY=1       same as --verify-only
       IMAGE_REPO=<repo>         default ghcr.io/aborek/sovereign-os   (UNCHANGED)
       SKIP_BUILD=1              unchanged: reuse an already-built local image
       DEPLOY_REGISTRY_PROBE=cmd `cmd <ref>` prints sha256:… (tests / no-tool machines)
       KUBE_CONTEXT NS REL WORK VALUES   unchanged
```

```
IMG=$IMAGE_REPO/os-ui:$VERSION          # was a literal ghcr.io/aborek/…
```

Three branches where there was one `if`:

```
if from-registry        -> remote_digest "$IMG"   (no docker at all)
elif SKIP_BUILD=1 && image present locally -> reuse, then smoke, then push
else                    -> build, smoke, push
```

`remote_digest <ref>` — first tool that exists wins, and it must print exactly `sha256:…`:

1. `DEPLOY_REGISTRY_PROBE` if set → `$DEPLOY_REGISTRY_PROBE <ref>`
2. `crane digest <ref>`
3. `skopeo inspect --format '{{.Digest}}' docker://<ref>`
4. `curl` against the registry v2 API: `GET https://<host>/token?service=<host>&scope=repository:<path>:pull`
   (basic-authed with `gh auth token` when `gh` is logged in), then
   `HEAD https://<host>/v2/<path>/manifests/<tag>` with
   `Accept: application/vnd.oci.image.index.v1+json, …manifest.v1+json, …docker.distribution.manifest.list.v2+json, …manifest.v2+json`
   and read `docker-content-digest` from the response headers.
5. none available → exit 1 naming all three, rather than deploying something unverified.

`docker manifest inspect` is deliberately **absent**: it needs the daemon this mode exists to
avoid.

The helm call gains exactly one conditional argument and keeps every existing one:

```
helm … upgrade … -f "$VALUES" \
  --set osUI.image.tag="$VERSION@$DIGEST" \
  ${IMAGE_REPO_SET:+--set osUI.image.repository="$IMAGE_REPO/os-ui"} \
  --force-conflicts --skip-schema-validation --timeout 20m
```

`IMAGE_REPO_SET` is set only when the operator passed `IMAGE_REPO`. With no `IMAGE_REPO` the
command line is **byte-for-byte what it is today**, so a default deploy cannot be changed by
this branch. The night-1 values derivation is not touched at all: it still carries the
operator's `osUI.image.repository` and the dagster user-deployment repositories over from the
live release, and `--set` only ever overrides on top of that.

`--verify-only` exits after printing the ref and the digest, **before** the first `kubectl`.
That ordering is the whole reason the mode is testable without a cluster.

### C · the widened conflict-copy check

```sh
find .. \( -path '*/node_modules' -o -path '*/.next' -o -path '*/.git' \) -prune -o \
        \( -name '* 2' -o -name '* 2.*' \) \( -type f -o -type d -o -type l \) -print -prune
```

`-print -prune` is the load-bearing part: print the match, then refuse to descend into it. On a
duplicated `os-ui/node_modules 2` the old expression would have printed one line per vendored
file; this prints one line, the directory. `-type l` is listed explicitly because a symlink is
neither `f` nor `d`.

`scripts/check-structure.mjs` gets the same rule as a second door, scoped and hard:

```
rule 7  CLOUD-SYNC-DUPLICATE   roots: os-ui/ charts/ scripts/ docs/
        a DIRECTORY whose basename matches / 2$/ (always a sync artefact), or a FILE
        matching / 2$/ or / 2\.[^/]*$/ — under docs/, only / 2$/ dirs and duplicated
        SOURCE files, so a hand-written `design 2.md` is not a failure
        never descends into node_modules | .next | a match | a dotted dir
        not in structure-baseline.json  ->  count > 0 fails
```

### D · `CONTRIBUTING.md` → "Images: build in CI"

Slots under "Operating this repo", after the Colima bullet it partly retires. Two fenced
blocks, one per owner option, then the two deploy commands:

```
git tag os-ui-v<version> && git push public os-ui-v<version>     # CI builds and pushes
IMAGE_FROM_REGISTRY=1 ./scripts/deploy.sh <version>              # roll it out, no Docker
```

### Decisions taken here, and what they cost

- **One job, not a matrix.** A tag names one image; a matrix would build four on every tag.
- **`load: true` then `push: true` for os-ui only.** The other three images have no run-path
  module graph to smoke — git-http is lighttpd + a CGI, git-daemon is a distro binary, dagster's
  contract is covered by `pytest images/extensions/dagster/tests/`.
- **No digest pinning of the pushed tag back into the chart.** `deploy.sh` resolves the digest
  at deploy time; writing it into `values.yaml` would make every build a commit.
- **`--verify-only` rather than a general `--dry-run`.** A dry run that stops somewhere in the
  middle of a deploy is a lie about what was verified; this stops at one honest boundary.

---

## Review round 1 — what the independent review found, and what changed (2026-11-19)

PR #62 blocked on H1. All thirteen findings are addressed; each has a test.

**H1 — the two doors could wedge a session (BLOCKER).**
(a) `os-ui/scripts/gate.sh`'s prune group lacked `.claude`, so the `* 2` scan walked into
`.claude/worktrees/*` — OTHER sessions' checkouts — and reported ~28 copied
`public/monaco/...` duplicates as strays in this tree. A worktree runs its own gate; this one
now only polices the tree it is in.
(b) `scripts/check-structure.mjs` is the PostToolUse hook on Write|Edit, so a hard rule-7
failure fails every subsequent tool call — and a conflict copy is dropped by a sync daemon, in
a file nobody edited, at a moment nobody chose. Rule 7 is now **hard only when `CI` is set**
and a **warning with the exact paths** locally. CI stays the machine that never lets one
through; a stray mid-edit can no longer wedge a session.

**M2 — `.dockerignore` had only `**/* 2.*`**, which needs a dot in the name, so an
extension-less `Dockerfile 2` and (worse) a duplicated DIRECTORY still entered the build
context. Added `**/* 2` and `**/* 2/`.

**M3 — a split-namespace deploy would ImagePullBackOff.** The digest comes from the image being
built; the repository comes from the live release. Once option A is taken, a plain
`deploy.sh 0.9.6` would push to `aborek` and pin that digest against a `data-masterclass`
repository — after the backup gate, after the push, with the old ReplicaSet already gone. A
digest is only meaningful inside one repository, so `scripts/lib/check-image-repo.py` now
**refuses** the mismatch and names the two `IMAGE_REPO=` commands that resolve it. Checked only
when `IMAGE_REPO` was not passed; with it, the upgrade `--set`s the repository so the two agree
by construction. (Implemented for BOTH the local-build and the `--from-registry` path: the
mismatch is identical in each, and with an explicit `IMAGE_REPO` neither can trip it.)

**M4 / L8 / L9 — the curl fallback.** Moved out of `deploy.sh` into
`scripts/lib/registry-digest.sh`, which (M4) captures `%{http_code}` and reports **401/403 —
not authorised for a private package, the token lacks `read:packages`** distinctly from **404 —
the tag was never pushed**; (L8) carries `--max-time 30` on both calls so a hanging registry
cannot hang a deploy; and (L9) passes credentials on **stdin via `curl -K -`** instead of `-u`
in argv, where any process could read them from `ps`. `REGISTRY_CURL` substitutes the binary,
which is what lets the test drive every status code with no network.

**M5 — the pull-secret advice was wrong.** A `dockerconfigjson` secret is keyed by registry
**host** (`ghcr.io`), not by namespace, so nothing needs "re-pointing". What actually bites is
that `GITHUB_TOKEN` creates the package **private and repo-scoped**: the `data-masterclass`
package must be made public or readable by the account behind the cluster's existing `ghcr.io`
credential — and since the other images stay in `ghcr.io/aborek`, one credential must read both
namespaces for as long as that is true.

**L6 — the smoked image might not be the pushed image.** Two `build-push-action` calls share a
context and a cache, so they *should* produce one image — but "should" is not a check. A step
now compares the smoked image's config id with the config digest inside the pushed manifest and
fails if they differ.

**L7** `timeout-minutes: 45` on the build job. **L10** the registry login user is
`vars.IMAGE_REGISTRY_USER || github.actor`, because under option B it must be the PAT's owner
(`aborek`) and not whoever pushed the tag; documented in CONTRIBUTING. **L11** the design
section's regex line was wrong (`/(^| )2$/` would match a file named `2`) — corrected to what
the code does. **L12** rule 7's `docs/` arm is narrowed to `/ 2$/` directories plus duplicated
SOURCE extensions, so a hand-written `design 2.md` is prose, not a build failure.

Tests: **85 assertions, 0 failures** (was 37). `os-ui/scripts/gate.sh` green (436 tests, 432
pass, 0 fail, 4 todo) · `check-structure` 419/1/200/1230 in **both** modes · `helm lint` 0
failed · `add-spdx-headers.sh --check` clean · all four workflows YAML-parse. Both real probes
re-verified against the live private GHCR tag `0.9.5` (crane and the curl fallback return the
same digest) and a real missing tag classifies as `REGISTRY_TAG_NOT_FOUND`.

### Review round 2 — three lows, closed (re-review says merge)

**L1 — the two doors disagreed about prose.** Rule 7 permits `docs/notes 2.md`; the gate still
hard-failed on it. Two doors that disagree are worse than one door, because whichever is
stricter quietly becomes the real rule. `os-ui/scripts/gate.sh` now prunes `../docs` from the
strict sweep and scans it with the same narrowing rule 7 uses — directories (and symlinks)
named `* 2`, plus duplicated SOURCE files from the same extension list. `-path '../docs'` pins
the TOP-LEVEL docs only, so a nested `*/docs` stays strict, exactly as rule 7 scopes it. Every
pattern is written out inline: a `* 2.ts` pattern held in a shell variable word-splits on its
own space and find then matches nothing.

**L2 — the token leg was unclassified.** It was judged only by whether a token came back, so a
DNS failure, a proxy, or a registry 500 on *that* call all reported "not authorised / the
package is private" — sending the reader after a credential problem that did not exist. The
token call now carries `-w '%{http_code}'` and branches: `000` unreachable (and says it is not
a credential problem), `5xx` registry error, `401|403` auth with the `read:packages` fix,
anything else `REGISTRY_TOKEN_HTTP_<code>`. The body is parsed only on a 200 — and a 200 with
no token still reports auth, because that is literally how GHCR denies an anonymous request for
a private package.

**L3 — "no repository pinned" was treated as safe.** It is not: the CHART DEFAULT then applies,
and that default is the laptop/kind profile, a bare `sovereign-os/os-ui` no registry serves.
Pinning a `ghcr.io/...` digest against it is the same ImagePullBackOff by another route.
`check-image-repo.py` takes the chart values as an optional third argument and, when the derived
values pin nothing, compares the expected repository against the chart default instead of waving
it through; `deploy.sh` passes `$CHART/values.yaml`.

**Nits.** The `.dockerignore` comment claimed `**/* 2/` was needed because Docker treats a
trailing slash differently — it does not. A pattern matches a path element whether it is a file
or a directory, and excluding a directory excludes everything under it, so the redundant line is
gone and the comment now says why there is no third pattern. `scripts/lib/registry-digest.sh`
read like an executable CLI; its header now states what is true — a helper every caller runs
through `bash <path>`, mode 644, with the shebang there to name the interpreter for a reader and
for shellcheck.

Tests **85 → 115**, 0 failures. Gate green (436 tests, 432 pass, 0 fail, 4 todo) ·
check-structure 419/1/200/1230 in both modes · helm lint 0 failed · all four workflows
YAML-parse · SPDX clean. Re-verified against the live registry: crane and the curl fallback
return the same digest for `0.9.5`, a missing tag is `REGISTRY_TAG_NOT_FOUND`, and a genuinely
anonymous request is `REGISTRY_NOT_AUTHORISED (401)` — which it is.
