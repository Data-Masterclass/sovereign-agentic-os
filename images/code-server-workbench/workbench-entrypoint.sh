#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
#
# Wires the DOMAIN-SCOPED credentials (injected via the per-builder Secret as env)
# into the workbench, then hands off to the stock code-server entrypoint. Runs as
# the non-root `coder` user; everything it writes lands on the persistent PVC
# ($HOME) so it survives across sessions.
set -euo pipefail

DOMAIN="${WORKBENCH_DOMAIN:-default}"
FORGEJO_BASE="${FORGEJO_BASE:-http://forgejo-http:3000}"
PROJECT="/home/coder/project"

mkdir -p "$PROJECT" "$HOME/.config/git"

# Git identity (domain builder). Stored on the PVC.
git config --global user.name  "${GIT_USER_NAME:-Domain Builder}"   || true
git config --global user.email "${GIT_USER_EMAIL:-builder@${DOMAIN}.local}" || true
git config --global init.defaultBranch main || true

# Domain-scoped Forgejo credential helper. The token is the builder's DOMAIN token
# (never the global admin). We write a store file readable only by this user; the
# NetworkPolicy guarantees it can ONLY be used against this domain's Forgejo.
if [ -n "${FORGEJO_TOKEN:-}" ]; then
  host="$(printf '%s' "$FORGEJO_BASE" | sed -E 's#^https?://##; s#/.*$##')"
  scheme="$(printf '%s' "$FORGEJO_BASE" | sed -E 's#://.*$##')"
  umask 077
  printf '%s://%s:%s@%s\n' "$scheme" "${FORGEJO_USER:-builder}" "$FORGEJO_TOKEN" "$host" > "$HOME/.git-credentials"
  git config --global credential.helper store
fi

# First-run welcome so the builder sees their scope. Idempotent.
if [ ! -f "$PROJECT/WORKBENCH.md" ]; then
  cat > "$PROJECT/WORKBENCH.md" <<EOF
# ${DOMAIN} — Domain Builder Workbench

You are scoped to the **${DOMAIN}** domain. From here you can build, edit, and
administer ALL of this domain's artifacts in one place:

- **Software** — clone/edit/push your domain's Forgejo repos:
  \`git clone ${FORGEJO_BASE}/${DOMAIN}/<repo>.git\`  (your domain token is wired in)
- **Agents** — edit agent definitions in your domain's repo(s).
- **Data** — query your domain's governed data (scope enforced server-side):
  \`dq "select * from mart_sales limit 5"\`
- **Knowledge** — edit knowledge artifacts in your domain's repo(s).

This workbench cannot reach another domain's data, the cluster API, secrets, or
the public internet. Your work persists on a per-builder volume across sessions.
EOF
fi

exec /usr/bin/entrypoint.sh "$@"
