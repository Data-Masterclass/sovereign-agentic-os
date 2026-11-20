# git (and isomorphic-git)

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **git** — Licence: GPL-2.0 (run as a separate process from the Alpine package, never linked).
  Source: https://git.kernel.org/pub/scm/git/git.git — Pinned as: Alpine 3.21 `git` + `git-daemon`
  packages in `images/base/git-daemon` and `images/base/git-http`.
  Docs used by WP-55: `git daemon --access-hook` (https://git-scm.com/docs/git-daemon),
  `git http-backend` / `GIT_PROJECT_ROOT` (https://git-scm.com/docs/git-http-backend),
  rename detection behind `git log --follow` (https://git-scm.com/docs/git-log#Documentation/git-log.txt---follow),
  subtree-split semantics (https://git-scm.com/docs/git-subtree).
  Docs used by WP-51 (lifecycle as tags): annotated tags (https://git-scm.com/docs/git-tag),
  `git for-each-ref` with `%(trailers:key=…)` (https://git-scm.com/docs/git-for-each-ref),
  trailers (https://git-scm.com/docs/git-interpret-trailers), `rev-list --before`
  (https://git-scm.com/docs/git-rev-list).
- **isomorphic-git** — Licence: MIT. Source: https://github.com/isomorphic-git/isomorphic-git —
  Pinned as: npm `isomorphic-git@1.44.13` (`os-ui/package.json`). Docs used: `writeBlob`,
  `writeTree`, `writeCommit` (multiple parents = a merge commit), `isDescendent`,
  `annotatedTag({ force })` and `deleteRef` (WP-51)
  (https://isomorphic-git.org/docs/en/alphabetic).

**Why the OS ships it:** every artifact the OS builds lands in a real git repository —
`domain-<domain>`, `user-<token>` and `platform` (component design 12) — served by git's own
daemon and http-backend.

## WP-56: the backup-tools image (git bundle backups and restore drills)

- **Pinned as:** Alpine 3.21 packages in `images/base/backup-tools/Dockerfile`, base
  `alpine:3.21@sha256:bc21487101ae47172509130ee1092cc273a831968d64b617776d1f69c81e42ab`:
  `git=2.47.3-r0`, `aws-cli=2.22.10-r0` (Apache-2.0), `jq=1.8.2-r0` (MIT), `curl=8.14.1-r3`
  (curl licence, MIT-style), `openssl=3.3.7-r2` (Apache-2.0). git is GPL-2.0-only, run as a
  separate tool binary, never linked (`licenses/components.tsv`).
- **Docs used:** `git bundle create / verify / list-heads` (https://git-scm.com/docs/git-bundle),
  `git fsck --full` (https://git-scm.com/docs/git-fsck), `git for-each-ref` / `git update-ref`;
  S3 `PutObject` with `Content-MD5` and Object Lock headers
  (https://docs.aws.amazon.com/cli/latest/reference/s3api/); STACKIT Object Lock
  (https://docs.stackit.cloud/products/storage/object-storage/basics/object-lock/,
  https://docs.stackit.cloud/products/storage/object-storage/how-tos/create-and-manage-object-lock/).
- **Why not isomorphic-git:** 1.44.13 has no bundle API (it exports `packObjects`/`indexPack`, no
  bundle read/write), so git's own CLI bundles, verifies and fscks.
