# Forgejo — self-hosted git

**What it is:** Forgejo (GPLv3+) — sovereign Git hosting for the **Software golden path**. A
demo repo (`demo-app`) with a sample app manifest is seeded; **Argo CD** deploys it. Lean
local: sqlite, single replica.

## Access
```bash
kubectl -n agentic-os port-forward svc/forgejo-http 3001:3000
# http://localhost:3001
```
**Login:** `gitea_admin` / `forgejo-admin-local-dev`

## How to use it
- **Browse** the `demo-app` repo (`manifests/app.yaml` is what Argo deploys).
- **Push a change** to the manifest → Argo CD auto-syncs it to the `demo` namespace.
- **New repo:** create one, push your app + k8s manifests, then point an Argo Application at it.

## FAQ
**Q: CI?** Forgejo Actions (GitHub-Actions-compatible) is the CI, and the **CI runner is
deployed** (see the CI runner doc) — pushing `.forgejo/workflows/ci.yml` triggers a run the
runner executes (validated: `status: success`). Local builds push to Forgejo's registry;
Harbor is the production registry.
**Q: Why Forgejo not Gitea?** Non-profit (Codeberg e.V.), can't go open-core — most
sovereignty-aligned (stack-decisions.md).
