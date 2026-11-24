<!-- SPDX-License-Identifier: Apache-2.0 -->
# LiteLLM gateway image without the proprietary module (`litellm-oss`)

**Owner decision 2026-11-24:** the LiteLLM gateway image contains permissive code only. The upstream
image the chart ran until now, `ghcr.io/berriai/litellm-database:1.109.1@sha256:932c5444…`, ships the
proprietary `litellm-enterprise` 0.1.82 (`LicenseRef-Proprietary`) and the whole upstream
`enterprise/` directory with 40-odd old `litellm_enterprise` wheels and tarballs. LiteLLM core is MIT
(everything outside `enterprise/`), so we build our own image from the MIT package on PyPI and do not
install the proprietary one. Nothing in this image or in this repository is copied from, or written
after, the enterprise code: where core needs it, core already guards the import (below), and the one
patch we carry has nothing to do with it.

| | |
|---|---|
| Image | `ghcr.io/data-masterclass/sovereign-os/litellm-oss` (private org package), built by `build-images.yml` (tag `litellm-oss-v<version>`) |
| Source | `images/extensions/litellm-oss/` — `Dockerfile`, `requirements.in` → `requirements.lock` (hash-pinned, `lock.sh`), `upstream-constraints.txt`, `patches/` |
| Licence gate | `node scripts/license-gate-image.mjs --image <ref> --scope litellm-oss --strict` (strict: the repo-wide ratchet never applies here, only the exact-version exceptions) — in `license-gate.yml` (job `litellm-oss-image`, with the upstream image as negative twin) and before every push in `build-images.yml` |
| Behaviour test | `scripts/tests/litellm-oss/run.sh` (30 checks of what the OS uses), plus the existing harnesses with `LITELLM_IMAGE=<ref>` |
| Chart | `litellm.image` in `charts/sovereign-agentic-os/values.yaml` (default: this image); rollback: `deploy/overlays/litellm-upstream-image.yaml` |

## What is in the image

- `litellm==1.109.1` (MIT) from PyPI, and the dependencies of its `proxy` extra **spelled out** in
  `requirements.in`, because the extra itself declares `litellm-enterprise==0.1.82 ; extra == 'proxy'`.
  `pip install "litellm[proxy]"` therefore always installs the proprietary package; this image never
  installs an extra of litellm.
- What the `litellm-database` variant adds: `prisma==0.11.0` (Apache-2.0), the Prisma CLI 5.4.2 and
  its engines (npm, Apache-2.0) under `/opt/prisma/binaries`, the client generated at build time from
  LiteLLM's own `schema.prisma`, `PRISMA_OFFLINE_MODE=true`.
- From the `proxy-runtime` extra, only what the chart configures: the OpenTelemetry packages for the
  `langfuse_otel` callback (`LITELLM_OTEL_V2=true`).
- `litellm-proxy-extras==0.4.113` (MIT) — the migrations; the exact version `litellm` pins.
- Node.js 26.13.1 (the official binary, MIT; the same minor upstream runs), only the `node` binary.
- The same Python (3.13) and the same library versions as the upstream image: `lock.sh` resolves
  against `upstream-constraints.txt`, which lists every distribution of the upstream image.
- The layout the chart relies on: `litellm` as the entrypoint (the subchart passes
  `--config /etc/litellm/config.yaml`), port 4000, `WORKDIR /app`, and
  `/app/litellm/proxy/prisma_migration.py` + `/app/schema.prisma` for the `db-migrate` initContainer
  (`python litellm/proxy/prisma_migration.py`). Runs as root, like upstream (the subchart sets no
  `securityContext`).
- The admin console: the UI build ships **inside the MIT wheel** (`litellm/proxy/_experimental/out`,
  20 MB, built from `ui/litellm-dashboard`, which is outside `enterprise/`). Served at
  `/tools/litellm/ui/`; `POST /login` works (measured below).

The image is 1.49 GB against upstream's 1.76 GB.

### Prisma engines (supply chain)

- **The Prisma CLI is pinned.** `prisma` and `@prisma/engines` 5.4.2 are installed with `npm ci` from the
  committed `images/extensions/litellm-oss/prisma/package-lock.json`, which carries their sha512
  integrity. prisma-client-python then finds the CLI in place and never runs its own unpinned
  `npm install`. Regenerate the lock with `npm install --package-lock-only --ignore-scripts` in that
  folder.
- **The engine binaries are trusted the way Prisma trusts them.** These are the query and schema engines
  (Rust, Apache-2.0). `@prisma/engines`' install script and `prisma py fetch` download them from
  `binaries.prisma.sh` for the engine commit the pinned packages name (`ac9d7041ed77bcc8a8dbd2ab6616b39013829574`).
  Each download is verified against the `.sha256` file published next to it **on the same host**. So the
  trust anchor is TLS to `binaries.prisma.sh` plus the pinned engine commit; there is no independent
  checksum we hold.
- **Hardening option.** Commit the expected sha256 of each engine and check it after the download. Not
  done yet: the files differ per platform and per OpenSSL variant.

## What is left out, and what that changes

| Left out | Licence | Why it was there | Effect without it |
|---|---|---|---|
| `litellm-enterprise` 0.1.82, `/app/enterprise/` | proprietary | `proxy` extra; upstream build | Enterprise features off — the same as upstream without a licence key. Every import site is guarded (next section). |
| `litellm-admin-mcp` 0.1.0 | (no licence metadata) | upstream build | none for the OS (not referenced by core or the chart) |
| `restrictedpython` 8.5 | ZPL-2.1 | `proxy` extra | the custom-code guardrail sandbox is unavailable; the OS configures no guardrail |
| `soundfile` 0.12.1 + the native `libsndfile` | BSD-3 binding to LGPL-2.1 C library | `proxy` extra; upstream installs libsndfile | AWS Transcribe pass-through cost tracking cannot measure audio duration (logs a warning, records no duration). Needed patch 0001. |
| `psycopg-binary` 3.3.6 | LGPL-3.0 + its own bundled libpq/OpenSSL 1.1/Kerberos build | `litellm-proxy-extras` | none: the pure-Python `psycopg` uses the system `libpq5` (PostgreSQL licence) |
| `hf-xet` | Apache-2.0, but embeds MPL-2.0 Rust crates | `huggingface-hub` | `huggingface-hub` falls back to plain HTTP downloads (Xet storage only) |
| `ddtrace`, `sentry-sdk`, `langfuse` SDK, Google/Azure/Anthropic SDKs, `llm-sandbox`, `semantic-router`, … | various | `proxy-runtime` / `extra_proxy` extras | none for the OS: the chart configures none of these integrations |

## Enterprise import sites in LiteLLM 1.109.1 core (16 files)

Read from the 1.109.1 wheel (`grep -rn litellm_enterprise litellm/`), and measured on the running
image with `PROBE_LITELLM_LOG=DEBUG scripts/tests/litellm-oss/run.sh`. **No site hard-fails**; no patch
is needed for the enterprise module.

| Site | Import | Guard | Behaviour without the module (measured where marked) |
|---|---|---|---|
| `proxy/proxy_server.py:1131` | `from litellm.proxy import enterprise` / `import enterprise` | `except Exception: pass` | nothing loaded |
| `proxy/proxy_server.py:1138` | `litellm_enterprise.proxy.enterprise_routes`, `…proxy_server.EnterpriseProxyConfig` | `except ImportError` | `enterprise_router` stays the empty `APIRouter()` defined above it; `enterprise_proxy_config = None`, so `load_enterprise_config` is skipped |
| `proxy/proxy_server.py:11730` | `…common_utils.check_batch_cost` | `except Exception` | batch-cost polling job not scheduled — **measured**: DEBUG "Checking batch cost … is an Enterprise Feature. Skipping…" |
| `proxy/proxy_server.py:11761` | `…common_utils.check_responses_cost` | `except Exception` | responses-cost job not scheduled — **measured** (same message) |
| `proxy/proxy_server.py:21001` | string `"litellm_enterprise"` only | — | module-owner comparison, no import |
| `proxy/auth/user_api_key_auth.py:191` | `…proxy.auth.user_api_key_auth.enterprise_custom_auth` | `except ImportError` | `enterprise_custom_auth = None`; the auth path checks `is not None` and skips it. Every authenticated call in the probe went through this path. |
| `proxy/auth/route_checks.py:116` | `…proxy.auth.route_checks.EnterpriseRouteChecks` | `except HTTPException: raise` / `except Exception: pass` | no extra route restriction (management routes stay governed by core's own role checks) |
| `proxy/management_endpoints/key_management_endpoints.py:1573` | `…apply_enterprise_key_management_params` | `except Exception` | `/key/generate` keeps the request as sent — **measured**: DEBUG "Enterprise key management params not applied - No module named 'litellm_enterprise'" on each generate; keys work (probe, agent-key-migration) |
| `proxy/utils.py:100` | email loggers (base, Resend, SendGrid, SMTP) | `except ImportError` | set to `None`; no email alerting |
| `proxy/hooks/key_management_event_hooks.py:505, 544, 614, 623` | email loggers + event types | `except ImportError` → return | key created/rotated e-mails not sent |
| `proxy/hooks/user_management_event_hooks.py:145` | `BaseEmailLogger` | `except ImportError` → return False | invite e-mail not sent |
| `proxy/hooks/__init__.py:69` | `from enterprise.enterprise_hooks import ENTERPRISE_PROXY_HOOKS` | `except ImportError` | `{}` |
| `proxy/common_utils/callback_utils.py:206, 221, 287` (+ `enterprise.enterprise_hooks.*` at 236, 271, 300, 315) | Llama Guard, secret detection, LLM Guard, moderation hooks | `except ImportError` → raises a clear error **only if that callback is configured** | the chart configures `callbacks: ["langfuse_otel"]` only |
| `proxy/guardrails/guardrail_initializers.py:203` | `_ENTERPRISE_SecretDetection` | `except ImportError` → error only if the `hide_secrets` guardrail is configured | not configured |
| `proxy/management_endpoints/customer_endpoints.py:236` | `enterprise.enterprise_hooks.blocked_user_list` | inside a function, guarded | only for the blocked-user list feature |
| `proxy/management_endpoints/ui_sso.py:1195` | `EnterpriseCustomSSOHandler` | guarded, only with a custom SSO handler | the OS logs in with `POST /login` (measured: 303 + session cookie) |
| `proxy/public_endpoints/public_endpoints.py:427` | `EnterpriseProxyConfig.get_custom_docs_description` | `except Exception` | default docs text |
| `proxy/response_api_endpoints/endpoints.py:1049` | `CheckResponsesCost` | `except ImportError` → `None` | no per-response cost re-check |
| `proxy/ui_crud_endpoints/proxy_setting_endpoints.py:482` | comment only (extension point) | — | — |
| `integrations/custom_guardrail.py:1337, 1366` | `EnterpriseCustomGuardrailHelper` | `except ImportError` | guardrail event-hook mode falls back to core logic |
| `litellm_core_utils/litellm_logging.py:277, 306` | callback controls, payload setup, alerting loggers | `except Exception` | `EnterpriseCallbackControls = None`; `GenericAPILogger` falls back to `CustomLogger` (the generic-API logger is not available); PagerDuty/e-mail alerting off |
| `litellm_core_utils/custom_logger_registry.py:127` | PagerDuty, e-mail loggers | `except ImportError` | not registered |

Also measured: `Enterprise billing metrics disabled: deployment is not licensed`. This comes from
`proxy/enterprise_billing/billing_metrics.py`, which is **MIT core** (outside `enterprise/`): an OTLP/HTTP
metering exporter that pushes usage counts to BerriAI's collector over mutual TLS. **It is inactive in
this image.** `build_billing_metrics_recorder` returns nothing unless the deployment is licensed **and**
`LITELLM_BILLING_METRICS_ENDPOINT`, `LITELLM_BILLING_METRICS_CLIENT_CERT` and
`LITELLM_BILLING_METRICS_CLIENT_KEY` are all set (optionally `…_CA_CERT`, `…_EXPORT_INTERVAL_MS`). The
chart sets none of them, and there is no licence. The gateway's egress policy would also block that
destination.

## What we patch (MIT core, `images/extensions/litellm-oss/patches/`)

Applied with `patch --forward` at build time; a LiteLLM bump that moves the code fails the build.

| Patch | File | Why |
|---|---|---|
| `0001-lazy-soundfile-import.patch` | `proxy/pass_through_endpoints/llm_provider_handlers/transcribe_passthrough_logging_handler.py` | A module-level `import soundfile` in a module the proxy imports at boot made the whole proxy fail without the LGPL `libsndfile` (`OSError: cannot load library 'libsndfile.so'`). Moved into the one function that uses it, which already returns "duration unknown" on decode errors; `ImportError` added to those. |

No patch touches an enterprise import site.

## Reviewed exceptions (copyleft packages)

**Owner sign-off: 2026-11-24, written** (relayed on PR #346). **Scope: the `litellm-oss` image only.**
Everything else in the image must be permissive. The image gate fails on any other non-permissive package,
and on one of these four at any version other than the one signed off.

| Package | What it is | Licence | Why the gateway needs it |
|---|---|---|---|
| `psycopg` 3.3.6 | PostgreSQL driver for Python (the pure-Python implementation, on the system `libpq5`) | LGPL-3.0-only | `litellm-proxy-extras` (LiteLLM's MIT migration package) declares it and **both** migration resolvers import it unguarded: v2, the default, in `migration_lock.migration_lock`; v1 in `request_log_indexes.ensure_request_log_indexes`. Measured: without it `db-migrate` exits with `ModuleNotFoundError: No module named 'psycopg'`, so the gateway cannot start on its database. |
| `certifi` 2026.10.19 | Mozilla's CA certificate bundle as a Python package | MPL-2.0 | `httpx`, the HTTP client of LiteLLM and of the OpenAI SDK, imports it for TLS verification on every provider call. |
| `orjson` 3.13.0 | JSON serialiser (compiled extension) | MPL-2.0 AND (Apache-2.0 OR MIT) | imported unguarded across `litellm/proxy` (request parsing, every endpoint module) |
| `tqdm` 4.67.3 | progress-bar library | MPL-2.0 AND MIT | imported by `huggingface-hub`, a core dependency of LiteLLM (tokenizers) |

**The conditions each one meets** (condition `unmodified-not-linked` in `licenses/exceptions.images.json`):
- **Unmodified.** The exact wheels from PyPI, hash-pinned in `requirements.lock`. No file of these
  packages is patched; our only patch, 0001, touches LiteLLM.
- **Dynamically imported, not linked.** Separate Python packages, loaded by `import` at run time. Nothing
  is statically linked or compiled together with them.
- **Replaceable.** They live in a plain virtual environment (`/app/.venv`). Replacing one means installing
  another build of it there, or changing `requirements.in`, running `lock.sh` and rebuilding the image.
  Both ways are written down for psycopg in the image's `THIRD_PARTY_NOTICES.md`.
- **Notices and sources.** Full licence texts ship in the image under
  `/usr/share/licenses/litellm-oss/`:
  - `packages/<pkg>/` holds each package's own licence files;
  - `texts/` holds the full LGPL-3.0's referenced GPL-3.0 and the MPL-2.0;
  - `THIRD_PARTY_NOTICES.md` names each exact source (PyPI sdist and sha256) and how to replace psycopg.
  
  The repository records them in `licenses/source-offer.md` and in `THIRD-PARTY-LICENSES.md` ("Copyleft
  source availability"). `psycopg-binary`, which bundles its own libpq/OpenSSL build, is **not** shipped.
- **Review.** Each entry has an exact version, so a bump makes the entry unused and the gate fails until the
  owner signs the new version off. Latest re-review date: **2027-05-24**.

**Planned exit.**
- **psycopg:** the upstream proposal below asks `litellm-proxy-extras` to take its advisory lock and index
  DDL through the Prisma connection the migration already holds, or to make the driver optional. With
  that, a permissive driver path (or none) is possible and the exception can be dropped.
- **certifi:** could be replaced by the system CA bundle once httpx no longer imports it unconditionally.
- **orjson, tqdm:** stay until LiteLLM or huggingface-hub make them optional; tracked with the same
  upstream issue.

Base-image layer (Debian, not scanned by the image gate, the same for every image of this repo): the
`python:3.13-slim` base (glibc LGPL, bash/coreutils GPL as separate programs, …) plus the packages
this image adds: `libatomic1` (GCC runtime library exception), `libpq5` (PostgreSQL) and its
dependencies `libkrb5-3`/`libgssapi-krb5-2`/`libk5crypto3`/`libkrb5support0`/`libcom-err2` (MIT),
`libldap2` (OpenLDAP), `libsasl2-2` (BSD-style), `libkeyutils1` (LGPL-2.1+).

Five permissive licence ids were added to `licenses/policy.json` `allow` for the Rust crates compiled
into `litellm`'s `rust_bridge`, `orjson` and `pydantic-core`, and for `regex`: `Unicode-3.0`,
`Unicode-DFS-2016`, `BSL-1.0` (**Boost** — not the Business Source License, which stays forbidden),
`CDLA-Permissive-2.0` and `CNRI-Python`. Two packages without machine-readable licence metadata are
declared in `licenses/image-licence-overrides.json` (tiktoken → MIT, the OpenSSL inside
`cryptography` → Apache-2.0), each with its evidence. **Owner approval 2026-11-24** for all seven.
Each of the five ids was checked against its primary source (the SPDX License List entry, OSI approval
where it exists, and the licence text itself, all in `licenses/<id>.txt`). None has a copyleft clause or
any field-of-use or non-commercial restriction. What each licence obliges us to do, and where we do it:
`THIRD-PARTY-LICENSES.md` "Licence obligations by type".

## Draft upstream issue (not filed)

> **Title:** Make the OSS proxy installable and runnable without `litellm-enterprise` and other non-permissive dependencies
>
> LiteLLM core is MIT, and core already guards every import of `litellm_enterprise` (we checked all
> 16 files in 1.109.1; each degrades to the unlicensed behaviour). Three things still force
> non-MIT code into an OSS deployment:
>
> 1. **`litellm[proxy]` requires `litellm-enterprise`** (`Requires-Dist: litellm-enterprise==0.1.82 ; extra == 'proxy'`).
>    Proposal: move it to a separate extra (e.g. `proxy-enterprise`), or into `proxy-runtime`, so that
>    `pip install "litellm[proxy]"` installs only MIT code. The proxy runs without it today.
> 2. **`litellm-proxy-extras` hard-requires `psycopg` (LGPL-3.0)** and imports it unguarded in the
>    migration lock (`migration_lock.py`) and the request-log index build (`request_log_indexes.py`),
>    while other call sites already treat it as optional ("Safe no-op if psycopg isn't installed").
>    Proposal: either take the advisory lock and the index DDL through the Prisma connection the
>    migration already holds, or make psycopg an extra and skip the lock/index steps with a clear
>    warning when it is absent, as `spend_logs_is_partitioned` does.
> 3. **A module-level `import soundfile`** in
>    `proxy/pass_through_endpoints/llm_provider_handlers/transcribe_passthrough_logging_handler.py`
>    makes the whole proxy fail at boot when the native `libsndfile` (LGPL-2.1) is not installed,
>    although only `media_file_seconds` uses it and already handles decode errors. Proposal: import it
>    inside that function and catch `ImportError`, like `litellm_core_utils/audio_utils/utils.py` does.
>    (A one-line PR; we carry it as a local patch.)
>
> We build an image from the MIT wheel with these three worked around and run our gateway test-suite
> against it and against `litellm-database:1.109.1`: identical results.

## Evidence (2026-11-24)

Local runs on a linux/arm64 build of this directory; the pinned image
(`1.109.1-soa.3@sha256:5ea2411f…`) was built and gated on linux/amd64 by `build-images.yml`
(run 45397687543).

| Check | `litellm-oss` | upstream `litellm-database:1.109.1` |
|---|---|---|
| `scripts/tests/litellm-oss/run.sh` (migrate, models, keys, calls, aliases, spend, MCP register + BYOK + OAuth credentials + protocol, UI + login; tag activity, teams, embeddings, and the two licence-gated core endpoints refused identically) | 30/30 | 30/30 |
| `scripts/tests/gateway-models/run.sh` (16 tests: OS model list, role mapping via `/config/update`) | pass | the harness was written against it |
| `scripts/tests/agent-key-migration/run.sh` (9 tests: `/key/generate`, `/key/update`, make-before-break) | pass | idem |
| `scripts/tests/reasoning-budget/run.sh` (6 tests) | pass | idem |
| `scripts/tests/llm-providers/run.sh` (11 tests: credentials, `/model/new` with access groups, egress proxy) | pass | idem |
| `scripts/tests/litellm-langfuse/run.sh` (`langfuse_otel`: one GENERATION per call with call id, tokens, cost; the legacy-callback twin red) | `LITELLM_LANGFUSE_TEST_OK … twin red` | idem |
| `scripts/license-gate-image.mjs --scope litellm-oss` | PASS: the four reviewed exceptions (psycopg, certifi, orjson, tqdm) and nothing else non-permissive; no enterprise trace. Without `--scope` it fails on psycopg (the exception is scoped to this image) | FAIL: 60 enterprise traces (the distribution, the importable module, 58 paths) plus RestrictedPython, psycopg(-binary), llm-sandbox, ddtrace, … |

The tracing e2e stack (`tests/langfuse/compose*.yaml`) and the orphan-span filter test now run the
chart's image too (`scripts/check-litellm-model-info.mjs` requires it); the CI jobs and live
workflows that pull it log in to GHCR with `packages: read`.

## Rollout and rollback

- **Dev first.** The chart default is this image; `main` deploys to dev automatically. Production
  gets it with the next release, after the owner has tested dev (the usual rule).
- **Production releases derive their values from the live release** (`scripts/deploy.sh`). If the
  live release pins `litellm.image` itself, the new default does not reach it; then deploy once with
  `VALUES_OVERLAY=deploy/overlays/litellm-oss-image.yaml`.
- **Rollback** (image only, no data change — the database schema is LiteLLM 1.109.1's either way):
  `VALUES_OVERLAY=deploy/overlays/litellm-upstream-image.yaml scripts/deploy.sh …` (dev: add
  `--env dev`). It sets `litellm.image` back to the upstream digest. Remove the overlay's effect by
  deploying `deploy/overlays/litellm-oss-image.yaml` again.
- Pulling the private org package needs `registry-pull-secret` in the namespace, which dev and
  production already have; the chart passes it to the LiteLLM subchart (`litellm.imagePullSecrets`).

## Bumping LiteLLM

1. Pull the new upstream image, regenerate `upstream-constraints.txt` from it (the header says how),
   bump `litellm==` and `litellm-proxy-extras==` in `requirements.in` (the latter to what the new
   `litellm` METADATA pins), re-read the `proxy` extra in its METADATA.
2. `images/extensions/litellm-oss/lock.sh`; build; the patch must still apply.
3. `grep -rn litellm_enterprise` over the new wheel: every new site must be guarded, or it needs a
   patch here and a line in the import-site table.
4. `node scripts/license-gate-image.mjs --image <local> --scope litellm-oss` (and `--write-notices
   licenses/notices/litellm-oss-image.md`), `scripts/tests/litellm-oss/run.sh` for both images, the
   harnesses with `LITELLM_IMAGE=<local>`; then tag `litellm-oss-v<version>-soa.<n>` and pin the digest.
