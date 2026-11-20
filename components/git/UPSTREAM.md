# git (and isomorphic-git)

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **git** — Licence: GPL-2.0 (run as a separate process from the Alpine package, never linked).
  Source: https://git.kernel.org/pub/scm/git/git.git — Pinned as: Alpine 3.21 `git` + `git-daemon`
  packages in `images/base/git-daemon` and `images/base/git-http`.
  Docs used by WP-55: `git daemon --access-hook` (https://git-scm.com/docs/git-daemon),
  `git http-backend` / `GIT_PROJECT_ROOT` (https://git-scm.com/docs/git-http-backend),
  rename detection behind `git log --follow` (https://git-scm.com/docs/git-log#Documentation/git-log.txt---follow),
  subtree-split semantics (https://git-scm.com/docs/git-subtree).
- **isomorphic-git** — Licence: MIT. Source: https://github.com/isomorphic-git/isomorphic-git —
  Pinned as: npm `isomorphic-git@1.44.13` (`os-ui/package.json`). Docs used: `writeBlob`,
  `writeTree`, `writeCommit` (multiple parents = a merge commit), `isDescendent`
  (https://isomorphic-git.org/docs/en/alphabetic).

**Why the OS ships it:** every artifact the OS builds lands in a real git repository —
`domain-<domain>`, `user-<token>` and `platform` (component design 12) — served by git's own
daemon and http-backend.
