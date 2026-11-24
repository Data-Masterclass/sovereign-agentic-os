# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# litellm-oss — the OS's LiteLLM gateway image, built ONLY from permissively licensed code.
#
# WHY. The upstream `ghcr.io/berriai/litellm-database` image ships `litellm-enterprise`
# (LicenseRef-Proprietary). Owner decision 2026-11-24: the gateway image contains permissive code
# only. LiteLLM core is MIT; this image installs it from PyPI and simply does not install the
# proprietary package (core guards every import of it: docs/components/litellm-oss.md "Enterprise import sites").
# Nothing here is copied from, or written after, the enterprise code.
#
# WHAT MATCHES UPSTREAM (the chart relies on each):
#   - `litellm` on PATH as the entrypoint, args `--config /etc/litellm/config.yaml` from the subchart;
#     port 4000 (CMD), WORKDIR /app
#   - /app/litellm/proxy/prisma_migration.py + /app/schema.prisma: the `db-migrate` initContainer
#     runs `python litellm/proxy/prisma_migration.py` in /app (values.yaml litellm.extraInitContainers)
#   - the Prisma client generated at build time, the Prisma CLI 5.4.2 + engines under
#     /opt/prisma/binaries, node on PATH, PRISMA_OFFLINE_MODE=true (no download at runtime)
#   - the same Python (3.13) and the same library versions (upstream-constraints.txt)
#   - runs as root, like upstream (the subchart sets no securityContext); see docs/components/litellm-oss.md
#
# Build:  docker build -t litellm-oss images/extensions/litellm-oss
# Gate:   node scripts/license-gate-image.mjs --image litellm-oss --scope litellm-oss
ARG PYTHON_BASE=python:3.13-slim@sha256:6d68eb6310a906f26c7638eb6ea7557d4261662df3181af2f80f1f9a7e34c549

# ------------------------------------------------------------------------------------------------
FROM ${PYTHON_BASE} AS build
ARG TARGETARCH
# Node.js: the official release tarball, checksum-pinned per arch (nodejs.org SHASUMS256.txt). The
# same major/minor the upstream image runs. Only the build stage keeps npm; the runtime gets `node`.
ARG NODE_VERSION=26.13.1
ARG NODE_SHA256_AMD64=5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864
ARG NODE_SHA256_ARM64=89e1853138db51e8b82d3e98ba9c0d3f2956a28e5e55ea1b7e12d25aae92d5dd
RUN set -eux; \
    apt-get update; apt-get install -y --no-install-recommends curl xz-utils ca-certificates libatomic1 patch; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x64;   sum=$NODE_SHA256_AMD64 ;; \
      arm64) arch=arm64; sum=$NODE_SHA256_ARM64 ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    echo "$sum  /tmp/node.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/node; tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1; rm /tmp/node.tar.xz
ENV PATH=/app/.venv/bin:/opt/node/bin:$PATH

# Python dependencies: hash-pinned, --no-deps (the lock is the whole closure; nothing is resolved here,
# so nothing the lock leaves out — litellm-enterprise, psycopg-binary — can come back).
# FOUR NON-PERMISSIVE PACKAGES ARE INSTALLED HERE, under a reviewed, written owner exception (2026-11-24,
# scope: this image only): psycopg 3.3.6 (LGPL-3.0-only) and certifi 2026.10.19, orjson 3.13.0, tqdm 4.67.3
# (MPL-2.0). Unmodified wheels from PyPI, dynamically imported, replaceable; full licence texts and the
# LGPL source/replacement notes go to /usr/share/licenses/litellm-oss (runtime stage below).
# Why each is needed and the exit plan: docs/components/litellm-oss.md "Reviewed exceptions";
# the entries: licenses/exceptions.images.json. Any OTHER non-permissive package fails the image gate.
WORKDIR /app
COPY requirements.lock /tmp/requirements.lock
# (Keep the install alone in its RUN: scripts/license-gate.mjs parses `pip install` statements, and the
# lock is gated on the built image instead — scripts/license-gate-image.mjs.)
RUN python -m venv /app/.venv
RUN pip install --no-cache-dir --require-hashes --no-deps -r /tmp/requirements.lock
RUN python - <<'EOF'
import importlib.metadata as m, importlib.util as u, sys
names = {d.metadata["Name"].lower() for d in m.distributions()}
bad = sorted(names & {"litellm-enterprise", "litellm_enterprise", "litellm-admin-mcp", "psycopg-binary", "restrictedpython", "soundfile", "hf-xet"})
if bad or u.find_spec("litellm_enterprise") is not None:
    sys.exit(f"excluded package installed: {bad or ['litellm_enterprise (importable)']}")
assert m.version("litellm") == "1.109.1", m.version("litellm")
print("ok: litellm", m.version("litellm"), "- no litellm_enterprise,", len(names), "distributions")
EOF

# Our patches to LiteLLM core (MIT): each file in patches/ says what it changes and why. Applied with
# --forward and must apply cleanly, so a LiteLLM bump that moves the code fails the build here.
COPY patches/ /tmp/patches/
RUN set -eux; \
    site=$(python -c "import sysconfig;print(sysconfig.get_paths()['purelib'])"); \
    for p in /tmp/patches/*.patch; do patch --forward --batch -p1 -d "$site" < "$p"; done; \
    python -c "import litellm.proxy.proxy_server; print('ok: litellm.proxy.proxy_server imports without libsndfile and without litellm_enterprise')"

# Prisma: the CLI (npm `prisma` 5.4.2, Apache-2.0) and its engines go to /opt/prisma/binaries, then the
# Python client is generated from LiteLLM's own schema into site-packages. Same layout and env as upstream.
# SUPPLY CHAIN: the CLI is installed with `npm ci` from the committed prisma/package-lock.json (sha512
# integrity of `prisma` and `@prisma/engines` 5.4.2), so prisma-client-python finds it in place and never
# runs its own unpinned `npm install`. The engine BINARIES are then downloaded by @prisma/engines' install
# script and `prisma py fetch` from binaries.prisma.sh, checked against the .sha256 files published next to
# them on that same host (Prisma's own mechanism; trust = TLS to binaries.prisma.sh). Their engine commit is
# fixed by the pinned packages (ac9d7041…); docs/components/litellm-oss.md "Prisma engines".
ENV PRISMA_BINARY_CACHE_DIR=/opt/prisma/binaries \
    PRISMA_CLI_QUERY_ENGINE_TYPE=binary \
    XDG_CACHE_HOME=/opt/prisma/.cache
COPY prisma/package.json prisma/package-lock.json /opt/prisma/binaries/
RUN cd /opt/prisma/binaries && npm ci --no-audit --no-fund
RUN set -eux; \
    schema=$(python -c "import litellm,os;print(os.path.join(os.path.dirname(litellm.__file__),'proxy','schema.prisma'))"); \
    cp "$schema" /app/schema.prisma; \
    prisma --version; \
    prisma generate --schema /app/schema.prisma; \
    prisma py fetch; \
    test -x /opt/prisma/binaries/node_modules/.bin/prisma

# The migration entrypoint the chart's initContainer calls by path (it is LiteLLM's own MIT file,
# shipped in the wheel; upstream copies the same file to the same place).
RUN mkdir -p /app/litellm/proxy \
 && cp "$(python -c "import litellm,os;print(os.path.dirname(litellm.__file__))")/proxy/prisma_migration.py" /app/litellm/proxy/

# ------------------------------------------------------------------------------------------------
FROM ${PYTHON_BASE}
# Runtime OS packages (Debian, on top of the base):
#   libatomic1  the official Node 26 binary links it (GCC runtime library, same licence and exception
#               as the base's own libgcc-s1)
#   libpq5      PostgreSQL's client library (PostgreSQL licence), loaded by the pure-Python psycopg that
#               LiteLLM's migrations need; replaces the libpq build psycopg-binary would bundle
# The Prisma engines link OpenSSL 3, which the base has.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libatomic1 libpq5 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/node/bin/node /usr/local/bin/node
COPY --from=build /opt/node/LICENSE /usr/share/licenses/nodejs/LICENSE
COPY --from=build /opt/prisma /opt/prisma
COPY --from=build /app /app
COPY LICENSE-NOTICE.md THIRD_PARTY_NOTICES.md /usr/share/licenses/litellm-oss/
# The full canonical text of EVERY licence id a package in this image is under (the chosen ids in
# licenses/notices/litellm-oss-image.md, plus GPL-3.0 which LGPL-3.0 incorporates): components compiled
# into a wheel (Rust crates) ship no licence file of their own, so these texts are how the image carries
# them. Obligations per licence: THIRD-PARTY-LICENSES.md "Licence obligations by type".
COPY licenses/ /usr/share/licenses/litellm-oss/texts/
# The owner-excepted copyleft packages (licenses/exceptions.images.json): their own licence files, copied
# next to the notices so they are findable without knowing site-packages. The build fails if one is missing.
RUN set -eu; \
    for t in 0BSD Apache-2.0 BSD-2-Clause BSD-3-Clause BSL-1.0 CC0-1.0 CDLA-Permissive-2.0 CNRI-Python GPL-3.0 \
             ISC LGPL-3.0 MIT MPL-2.0 PSF-2.0 Unicode-3.0 Unicode-DFS-2016 Unlicense Zlib; do \
      t="$t.txt"; \
      test -s "/usr/share/licenses/litellm-oss/texts/$t" || { echo "missing licence text licenses/$t" >&2; exit 1; }; \
    done; \
    site=/app/.venv/lib/python3.13/site-packages; \
    for p in psycopg-3.3.6 certifi-2026.10.19 orjson-3.13.0 tqdm-4.67.3; do \
      test -d "$site/$p.dist-info/licenses" || { echo "missing licence files of $p" >&2; exit 1; }; \
      mkdir -p "/usr/share/licenses/litellm-oss/packages/$p"; cp "$site/$p.dist-info/licenses/"* "/usr/share/licenses/litellm-oss/packages/$p/"; \
    done

ENV PATH=/app/.venv/bin:$PATH \
    PRISMA_BINARY_CACHE_DIR=/opt/prisma/binaries \
    PRISMA_CLI_PATH=/opt/prisma/binaries/node_modules/.bin/prisma \
    PRISMA_CLI_QUERY_ENGINE_TYPE=binary \
    PRISMA_OFFLINE_MODE=true \
    LITELLM_RELEASE_TAG=v1.109.1

LABEL org.opencontainers.image.title="litellm-oss" \
      org.opencontainers.image.description="LiteLLM 1.109.1 (MIT) gateway without the proprietary litellm-enterprise package" \
      org.opencontainers.image.source="https://github.com/Data-Masterclass/sovereign-agentic-os" \
      org.opencontainers.image.licenses="MIT" \
      org.sovereign-os.litellm-version="1.109.1" \
      org.sovereign-os.litellm-enterprise="absent"

WORKDIR /app
EXPOSE 4000
ENTRYPOINT ["litellm"]
CMD ["--port", "4000"]
