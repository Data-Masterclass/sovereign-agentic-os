<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Borek Data Ventures UG -->
# Releasing os-ui

**Rule:** no release reaches production unless the full CI passed on that exact commit, and
every deploy is followed by an automatic smoke test. Three things enforce it; one command
runs them all.

## The gate

| # | Gate | Where it lives | What stops |
|---|------|----------------|------------|
| 1 | Full CI on every push to `main` | `.github/workflows/ci.yml` (`push: main` + `pull_request`, same jobs) | nothing directly: it produces the green (or red) run the next gates read |
| 2 | The image build requires that green run | `.github/workflows/build-images.yml`, job `require-green-ci` | an `os-ui-v*` tag on a commit whose `ci.yml` or `license-gate.yml` push run on `main` is not `success` gets **no image** |
| 3 | The release script | `scripts/release.sh` | every step below |
| 4 | Green on dev | `.github/workflows/dev.yml`, job `dev-green`; read by `release.sh` | a commit whose dev deploy, smoke test or acceptance run was not green (or never ran) is not released: `NOT_GREEN_ON_DEV`. Until the dev environment exists, a local run passes `--no-dev-gate` (refused in CI). See [`ci-cd.md`](ci-cd.md) and [`dev-environment.md`](dev-environment.md) |

Gates 2 and 3 ask the same question through the same script, `scripts/lib/workflow-status.sh`:
*did the newest push run of each workflow, on this branch, for this SHA, conclude `success`?*
A PR run does not count: a rebase merge writes new commits, so what landed on `main` is a
different tree from what the PR tested.

## Releasing

```bash
./scripts/release.sh --dry-run 0.9.18     # every check, nothing changed — run this first
./scripts/release.sh 0.9.18               # the release
VALUES_OVERLAY=deploy/overlays/x.yaml ./scripts/release.sh 0.9.18   # with a values change
./scripts/release.sh --remote origin 0.9.18   # if your remote is not called `public`
```

In order, stopping at the first failure:

1. You are on `main`, tracked files are unchanged, and `main` fast-forwards to `<remote>/main`.
2. The tag `os-ui-v<version>` is free, or already points at this exact commit (a resume).
3. `ci.yml` and `license-gate.yml` passed on the push to `main` for this SHA. Still running:
   it waits (`RELEASE_CI_WAIT_MINUTES`, 45).
4. `node scripts/check-structure.mjs` and `node scripts/check-consoles-not-public.mjs` pass.
5. No cloud-sync duplicate (`* 2`, `* 2.*`) under `os-ui/`.
6. It tags the SHA, pushes the tag and waits for `build-images.yml` to pass for it.
7. `./scripts/deploy.sh --from-registry <version>` (backup gate, values from the live release,
   `VALUES_OVERLAY` passed through). Skipped if os-ui already runs `<version>`.
8. `./scripts/smoke-test.sh --expect-tag <version>`.

The last line says how it ended: `RELEASE_<version>_OK`, `RELEASE_<version>_DRY_RUN_OK`, or
`RELEASE_<version>_STOPPED: <reason>`. Run it directly, never through a pipe (see
CONTRIBUTING.md). It is safe to re-run: an existing tag on the same commit is reused, and a
version that is already live is not deployed again (only smoke-tested).

## When it stops

| It says | Do this |
|---------|---------|
| `not on branch main` / `uncommitted changes` | `git checkout main`; commit or stash. |
| `local main has commits that are not on <remote>/main` | Those commits never went through CI. Open a PR, or `git reset --hard <remote>/main`. |
| `CI ... is RED` | Fix it with a PR. Release the new commit, never the red one. |
| `CI ... has not finished` | Wait, re-run. A commit whose run was **cancelled** (a newer push to `main` cancels the older run) is red: release the newer commit. |
| `already exists on another commit` | Versions are never reused. Pick the next one. |
| `check-structure` / `check-consoles-not-public` fails | Run the script by hand to see why; fix it with a PR. |
| `cloud-sync duplicates` | Delete the listed `* 2` files. They are never tracked; they break `next build`. |
| `the image build ... is RED` | Read the `build-images` run. If the `require-green-ci` job failed, CI was not green: see above. |
| `deploy.sh failed` | Read its output. It stops before `helm upgrade` for most failures; then nothing changed. |
| `the smoke test failed` | The new version is live and something is wrong. Read the `FAIL` lines; if users are affected, roll back (below). |

## Rolling back

`release.sh` prints the Helm revision that was live before the deploy. Two ways back:

- **Preferred, the normal gate:** `./scripts/deploy.sh --from-registry <previous version>`.
  It takes a fresh backup and derives values like any deploy.
- **Emergency:** `helm --kube-context dmagenticos rollback agentic-os <revision> -n agentic-os`.
  Restores that revision's manifests **and values**. The backup taken by the failed deploy is
  minutes old, which is why this is acceptable in an emergency.

Then `./scripts/smoke-test.sh --expect-tag <previous version>`.

## The smoke test on its own

```bash
./scripts/smoke-test.sh                          # any time, read-only
./scripts/smoke-test.sh --expect-tag 0.9.18 --context dmagenticos --namespace agentic-os
```

It checks: os-ui and os-ui-worker on the tag and Ready; no CrashLoopBackOff or ImagePullBackOff
in the platform namespace (user-app pods are listed, not failed); `/api/health` 200 on the
public host; no Ingress to LiteLLM or Langfuse and their hostnames not served; the worker boot
line with `systems=hydrated`; the ClickHouse volume at least the chart's size; `model_info` on
every LiteLLM model. Hostnames and sizes come from the release values, never hard-coded.

## What deploy.sh now shows before it changes anything

`deploy.sh` derives the values from the live release, so a value the release already pins beats
a changed chart default, silently. It now prints three lists before the upgrade
(`scripts/lib/values-diff.py`): what this upgrade changes, which release values override the
chart default (to change one, use `VALUES_OVERLAY`), and which release values the chart does not
define. Secret-looking paths and non-plain values print as `(hidden)`.

## Tests

```bash
bash scripts/tests/release.test.sh       # release.sh + workflow-status.sh (real git, fake gh)
bash scripts/tests/smoke-test.test.sh    # smoke-test.sh (fake kubectl / helm / curl)
bash scripts/tests/values-diff.test.sh   # the deploy values diff
```

All three run in CI (`test-ui`).
