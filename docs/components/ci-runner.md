# CI runner — Forgejo Actions

**What it is:** The CI executor that completes the Software golden path: **push → CI →
deploy**. An `act_runner` (Forgejo's GitHub-Actions-compatible runner) with a
**Docker-in-Docker** sidecar, registered to Forgejo via a bootstrap that fetches a
registration token from the admin API. On push, Forgejo Actions dispatches the workflow and
this runner executes it.

## How it works
- The `demo-app` repo ships `.forgejo/workflows/ci.yml` (`on: [push]`). Pushing it triggers a
  run; the runner picks it up and executes the job. **Validated:** the demo run completes with
  `status: success`.
- Build/push: locally the target is **Forgejo's built-in OCI registry** (light, sovereign);
  on STACKIT, build with kaniko/buildah and push to **Harbor** (scan + sign).

## Inspect
```bash
kubectl -n agentic-os logs deploy/ci-runner -c runner --tail=20      # runner daemon
# runs: Forgejo UI -> demo-app repo -> Actions tab, or:
curl -u gitea_admin:forgejo-admin-local-dev \
  http://localhost:3001/api/v1/repos/gitea_admin/demo-app/actions/tasks   # (port-forward forgejo first)
```

## FAQ
**Q: Why is DinD privileged?** Image builders need it. It's the one privileged pod, isolated
to CI; on STACKIT prefer a rootless kaniko/buildah builder (no privilege).
**Q: Does it re-register on restart?** No — the registration is persisted to its PVC; it
registers once.
**Q: Where does the build image land?** Forgejo's registry locally (`forgejo-http:3000`);
Harbor in production. See the Forgejo + Harbor docs.
