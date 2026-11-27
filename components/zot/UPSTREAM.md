# Zot

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/project-zot/zot
- **Pinned as:** image `ghcr.io/project-zot/zot:v2.1.23@sha256:9d3de83ac2099e6f4843045b4c9b65b7e8baf40f92d28f54906dee9d4d390fd7`
  (multi-arch; the image's own entrypoint, args `serve /etc/zot/config.json`).
- **Docs used:** https://zotregistry.dev/latest/articles/authn-authz/ (htpasswd, access control, anonymous policy),
  https://zotregistry.dev/latest/articles/mirroring/ (sync extension, on demand), https://zotregistry.dev/latest/articles/retention/,
  hot reload of config and htpasswd (`pkg/cli/server/config_reloader.go`, `pkg/api/htpasswd.go` at v2.1.23).

**Why the OS ships it:** the App Builder's platform registry (spec 6.2): app images are pushed to
`apps/<domainKey>/<slug>` by the push pod and pulled by the nodes; base images are mirrored on demand.

The deployment that uses this pin lives in the chart (`charts/sovereign-agentic-os/templates/base/os-ui/software-registry.yaml`);
the htpasswd/access-control renderer is ours (`images/base/builder/zot-users`), the client in `os-ui/core/adapters/zot/`.
