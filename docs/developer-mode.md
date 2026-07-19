<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Developer Mode — build against the OS from your own machine

Developer Mode is the desktop layer on top of the governed [`sos` CLI](../cli/sos/README.md):
a reproducible **devcontainer**, a distributable **`sos` binary** (Homebrew tap /
signed archives), and **`sos push`** — edit analytics/app code locally and push it
**through the OS's governed path**, not around it.

The doctrine is the same as the CLI's: **local authoring, remote governed execution,
push-through-policy.** Your machine holds only a short-lived OAuth token. Role,
domains, OPA policy, row/document security and audit are re-resolved live on the
server for every call. `sos push` submits a **governed change request** (the same
`commit` the Software tab UI uses) — there is no privileged side-channel.

---

## 1. Spin up the devcontainer (one command)

The repo ships a [`.devcontainer/`](../.devcontainer/) with Go 1.22 (to build/run
`sos`), Node 20 (to build/run os-ui), git, jq, `helm` and `kubectl`, and the `sos`
binary **prebuilt on PATH**.

Any devcontainer-aware editor (VS Code, JetBrains, Zed, DevPod, Codespaces) opens it:

```sh
# VS Code:  "Dev Containers: Reopen in Container"
# or the devcontainer CLI:
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . sos --version
```

Then sign in and go:

```sh
sos login https://os.example.eu
sos whoami
```

The container is pinned to `golang:1.22-bookworm` so the toolchain matches the CLI's
`go.mod` exactly and cross-compiles cleanly.

---

## 2. Install `sos` on your host (Homebrew tap)

If you'd rather not use the container, install the released binary from the
**self-hosted Homebrew tap**:

```sh
brew tap sovereign-os/tap https://<your-instance-or-forgejo>/sovereign-os/homebrew-tap
brew install sovereign-os/tap/sos
sos --version
```

For locked-down / air-gapped instances, grab the signed archive + `checksums.txt`
from your instance's release page and put `sos` on your PATH. See
[§4 Publishing](#4-publishing-a-release-maintainers) for how those artifacts are cut.

Build from source works too (needs Go 1.22+):

```sh
cd cli/sos && go build -o sos . && ./sos --version
```

---

## 3. `sos push` — commit through policy

`sos push` takes a **local working dir** of app/analytics source (dbt models, Cube
YAML, app code), diffs it against the app's current governed tree, and submits the
changed files through the governed **`commit`** MCP tool — **as you**, the
authenticated user. It is a real governed change, not a raw `git push`.

```sh
# Preview only — computes the diff, submits NOTHING:
sos push --app app_123 --dir ./my-app --dry-run

# Submit the changeset through the governed path:
sos push --app app_123 --dir ./my-app -m "add region breakdown to orders model"
```

What happens:

1. **Walk** `--dir` into a `{path: content}` set (skips `.git`, `node_modules`,
   build output; skips binaries; refuses oversize files).
2. **Read** the app's current governed tree (via the governed read tool) and
   **diff** — added / modified files only. Files present in the app but absent
   locally are **left untouched** (`push` never silently deletes governed files).
3. **Preview** the diff. `--dry-run` stops here.
4. **Submit** via the governed `commit` tool. OPA + role + row/doc security are
   enforced server-side; a policy **DENY surfaces clearly** (the server's typed
   reason + hint), never a fake success.

### Promote after pushing

`commit` writes to your app's tree; it does **not** move the app up the tier ladder.
To request promotion (Personal → Domain → Company), pass `--promote`:

```sh
sos push --app app_123 --dir ./my-app -m "ship v2" --promote
```

`--promote` files a governed **promotion request** after a successful push (the same
`request_promotion` the UI files). A **Builder+** then approves it in their queue —
the CLI cannot self-approve. As a creator you *file the request and hand off*; the
approval gate is unchanged.

### Flags

| Flag | Meaning |
|------|---------|
| `--app <id>` | Target governed app id (required). |
| `--dir <path>` | Local working dir to push (default `.`). |
| `-m, --message <msg>` | Commit message. |
| `--dry-run` | Compute + preview the diff; submit nothing. |
| `--promote` | After a successful push, file a promotion request. |
| `--yes` | Skip the pre-submit confirmation prompt (for scripts/CI). |
| `--profile <name>` | Target a specific OS instance. |

### Honest failures

- **Not signed in (401)** → `run: sos login`.
- **Governed deny (403 / `forbidden`)** → the server's reason + hint (e.g. "requires
  builder; you are creator"), verbatim.
- **Nothing to push** → exits telling you the working dir matches the current tree.
- `not_found` / `bad_request` / `conflict` tool errors surface the server's message.

---

## 4. Publishing a release (maintainers)

Releases are cut with **[GoReleaser](https://goreleaser.com)** from the repo-root
[`.goreleaser.yaml`](../.goreleaser.yaml): one `git tag` → static `sos` binaries for
darwin/linux (amd64/arm64) → `checksums.txt` → an updated Homebrew tap formula.

Validate the config without releasing:

```sh
goreleaser check
goreleaser release --snapshot --clean --skip=publish   # dry-run into cli/sos/dist
```

Cut a real release (self-hosted tap; **no github.com in the trust path**):

```sh
export SOS_TAP_OWNER=sovereign-os
export SOS_TAP_REPO=homebrew-tap
export SOS_TAP_TOKEN=***                       # a scoped token for the tap repo
export SOS_DOWNLOAD_ROOT=https://os.example.eu/releases/sos   # your release host

git tag sos/v0.2.0
goreleaser release --clean
```

GoReleaser renders and commits the formula to your tap; the
[formula template](../cli/sos/packaging/homebrew/sos.rb.template) documents its shape
and lets you bootstrap or hand-maintain a tap for air-gapped instances.

**Sovereignty note:** point `SOS_DOWNLOAD_ROOT` and the tap repo at your **own
instance / Forgejo** so neither `brew install` nor the release download touches a US
SaaS. Tokens are secrets — pass them via env in CI, never commit them.

---

## Security posture

- **Front door, not back door.** Every `sos` verb — including `push` — hits the same
  governed library function the UI calls. OPA + row/doc security + audit apply
  unchanged. The registry stays authoritative; `push` *proposes*, policy *decides*.
- **No desktop secrets** beyond the short-lived OAuth token (keychain / `0600` file).
  Tokens are never printed, never committed, and rotate on refresh.
- **`push` never deletes.** It merges a changeset over the prior tree; removing a
  governed file is a deliberate, separate action — not a side effect of a local diff.

See [`cli/sos/ROADMAP.md`](../cli/sos/ROADMAP.md) for what's shipped vs planned and
[`docs/research/developer-mode-cli.md`](research/developer-mode-cli.md) for the design.
