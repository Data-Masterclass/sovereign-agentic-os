<!-- SPDX-License-Identifier: Apache-2.0 -->
# litellm-oss image — third-party notices for the copyleft packages

The image installs everything else under permissive licences (checked by
`scripts/license-gate-image.mjs`; the full list with licences is
`licenses/notices/litellm-oss-image.md` in the Sovereign Agentic OS repository). **Four packages are
under copyleft licences.** They are shipped under a reviewed, written exception the owner signed off
on **2026-11-24**, for **this image only** (`licenses/exceptions.images.json`). Why each one is needed:
`docs/components/litellm-oss.md`, section "Reviewed exceptions (copyleft packages)".

All four are installed **unmodified**, as the wheels published on PyPI (hash-pinned in
`images/extensions/litellm-oss/requirements.lock`). None is statically linked into, compiled into or
modified by any other code. Each is a separate Python package that the MIT-licensed LiteLLM code (or one
of its dependencies) imports **at run time**.

| Package | Version | Licence | Licence text in this image | Exact source |
|---|---|---|---|---|
| psycopg | 3.3.6 | LGPL-3.0-only | `packages/psycopg-3.3.6/LICENSE.txt` (LGPL-3.0) + `texts/GPL-3.0.txt` (the GPL-3.0 it incorporates) | https://pypi.org/project/psycopg/3.3.6/ — sdist `psycopg-3.3.6.tar.gz`, sha256 `c081f2250df751a943036e42db6df4571c66cd0aabe8291a7a506512b12007d2`; upstream https://github.com/psycopg/psycopg (tag `3.3.6`) |
| certifi | 2026.10.19 | MPL-2.0 | `packages/certifi-2026.10.19/LICENSE` + `texts/MPL-2.0.txt` | https://pypi.org/project/certifi/2026.10.19/ — sdist sha256 `035c1e85572b141bf1c3a3eff0e33a8eb74917522f2559075ff8d2fea780a1ae` |
| orjson | 3.13.0 | MPL-2.0 AND (Apache-2.0 OR MIT) | `packages/orjson-3.13.0/LICENSE-MPL-2.0`, `LICENSE-APACHE`, `LICENSE-MIT` | https://pypi.org/project/orjson/3.13.0/ — sdist sha256 `d1de5eb04485110c5da4c657e49168995d55e076b1ce60f1a042e254f4186c4f` |
| tqdm | 4.67.3 | MPL-2.0 AND MIT | `packages/tqdm-4.67.3/LICENCE` + `texts/MPL-2.0.txt` | https://pypi.org/project/tqdm/4.67.3/ — sdist sha256 `7d825f03f89244ef73f1d4ce193cb1774a8179fd96f31d7e1dcde62092b960bb` |

Paths are relative to `/usr/share/licenses/litellm-oss/` in the image. Each package's own files stay where
pip installed them, with their notices unchanged:
`/app/.venv/lib/python3.13/site-packages/<package>/` and `<package>-<version>.dist-info/`.

## psycopg (LGPL-3.0-only): source and replacing the library

- **Source.** The exact corresponding source is the PyPI sdist named above, which is the source of the
  unmodified wheel in this image. Borek Data Ventures UG will also provide a copy on request
  (`licenses/source-offer.md` in the repository).
- **You may replace it.** psycopg is a separate package in a plain Python virtual environment
  (`/app/.venv`), loaded by `import psycopg`, and is not linked into anything. To use a different or
  modified psycopg:
  - **at run time:** install your build over it in a derived image or container,
    `/app/.venv/bin/pip install --no-deps <your psycopg wheel or source dir>`;
  - **at build time:** change the `psycopg==` line in `images/extensions/litellm-oss/requirements.in`,
    run `images/extensions/litellm-oss/lock.sh`, then `docker build images/extensions/litellm-oss`.
  
  LiteLLM calls psycopg only through its public API. Any psycopg 3.x that loads the system `libpq5` (or
  its own) works.
- It uses the system `libpq5` from Debian (PostgreSQL licence). `psycopg-binary`, which bundles its own
  libpq build, is **not** shipped.

## certifi, orjson, tqdm (MPL-2.0)

The files are unmodified: no MPL-covered file was changed, and the notices in them are kept. The MPL-2.0
text is in `texts/MPL-2.0.txt`. The source of each version is the PyPI sdist named above, which is also the
"Source Code Form" the MPL refers to.
