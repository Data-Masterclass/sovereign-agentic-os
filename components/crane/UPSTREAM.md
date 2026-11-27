# crane (go-containerregistry)

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/google/go-containerregistry (`cmd/crane`)
- **Pinned as:** `v0.22.1` = commit `8a72a424fdecb4caa14f2d525e5d2503331442b5`, built from source into our builder image
  (`images/base/builder/Dockerfile`).
- **Docs used:** https://github.com/google/go-containerregistry/blob/v0.22.1/cmd/crane/doc/crane_push.md
  (`crane push <OCI layout dir> <ref> --image-refs`), `crane digest`, `crane copy`.

**Why the OS ships it:** the push-image step of the app-checks pipeline (`charts/sovereign-agentic-os/files/tekton/tasks/crane-push.yaml`):
the only pod that holds a domain's push credential, running no app code.
