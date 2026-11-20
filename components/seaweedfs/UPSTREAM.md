# SeaweedFS

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/seaweedfs/seaweedfs
- **Pinned as:** image `chrislusf/seaweedfs:4.52@sha256:57877e32bb90073b37dc109b438ba66e84fd5ed9ced5f5c04f56444ef243ce59`
  (released 2026-11-02).
- **Docs:** https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API ,
  https://github.com/seaweedfs/seaweedfs/wiki/Filer-Server-API

**Why the OS uses it:** the S3 store for dev and CI (MASTER-PLAN WP-46: STACKIT Object Storage in
production, SeaweedFS for dev/CI). Today it backs the kind acceptance harness
(`tests/e2e/kind/manifests/seaweedfs.yaml`, `weed server -s3` with the documented identity file);
the chart still bundles MinIO until WP-46. The pin lives in `tests/e2e/kind/versions.env`.
