# Argo CD — GitOps deploy

**What it is:** Argo CD (Apache 2.0) continuously deploys apps from **Forgejo** repos into
per-domain namespaces. The demo `Application` syncs `demo-app` → the `demo` namespace
(the `whoami` app).

## Access
```bash
kubectl -n agentic-os port-forward svc/argocd-server 8080:80
# http://localhost:8080
```
**Login:** `admin` / get the password:
```bash
kubectl -n agentic-os get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
```

## How to use it
- **Watch the demo app:** the `demo-app` Application shows Synced/Healthy; the `whoami`
  Deployment/Service live in the `demo` namespace.
- **Deploy your own:** create an `Application` pointing at a Forgejo repo + path → auto-sync.
- **CLI:** `argocd app list` / `argocd app sync <name>` (port-forward first).

## FAQ
**Q: How does it reach Forgejo?** `repoURL: http://forgejo-http:3000/...` (public demo repo,
no creds). Add repo credentials for private repos.
**Q: Auto-sync?** Yes — `automated: {prune, selfHeal}` + `CreateNamespace=true`.
**Q: This is the only non-toggleable Layer-3 component — why?** It's platform/GitOps infra;
scaling it off would orphan deployed apps. Disable via chart values if needed.
