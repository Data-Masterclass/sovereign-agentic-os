# Admin Console

**What it is:** This dashboard — a single pane over the whole stack. It reads live status from
the Kubernetes API (via a scoped ServiceAccount), lets you **turn components on/off** (scales
the workload 0↔1), and shows each component's **address, login, summary** and **docs**
(rendered in-app). Stdlib Python; no external dependencies.

> **Also available in-app.** The same capabilities are embedded in the OS UI at
> **Platform → Components** (route `/components`). The OS UI proxies this service **server-side**
> (`/api/platform/*`), so the browser never holds the Kubernetes token. Use whichever front door
> you prefer — this standalone console (port-forward `svc/admin-console`) or the OS UI tab.

## Access (UI)
```bash
kubectl -n agentic-os port-forward svc/admin-console 8080:8080
# http://localhost:8080
```

## How to use it
- **Status:** every component shows running / off / disabled / starting, refreshed periodically.
- **On/Off:** the toggle scales a Deployment/StatefulSet to 0 (off) or 1 (on). "core" items
  (Postgres, Argo CD, the console itself) aren't toggleable — manage those via chart values.
- **Docs:** the 📖 button opens the component's guide (these files). The header links to
  Cloud config + Getting started.

## FAQ
**Q: Off vs disabled?** *Off* = installed but scaled to 0 (toggle back on anytime). *Disabled*
= not deployed (set `<component>.enabled: true` in values + `helm upgrade` to install).
**Q: Permanent disable?** Use chart values; the toggle is a runtime on/off (helm upgrade may
restore scaled components).
**Q: What can it change?** Only workload scale + read status (least-privilege RBAC). It can't
edit configs or secrets.
