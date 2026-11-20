# Open Knowledge Format (OKF)

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0 (spec and reference tooling)
- **Source:** https://github.com/open-knowledge-format/open-knowledge-format
- **Pinned as:** spec v0.3 (`SPEC.md`) and the reference validator
  `skills/okf-generate/scripts/validate.py` at commit `527e81aff55992be21507e97004286789126f88c`,
  vendored unmodified at `os-ui/scripts/okf/validate.py` (pin, blob and sha256 in `os-ui/scripts/okf/pin.json`).
- **Docs for this pin:** https://github.com/open-knowledge-format/open-knowledge-format/blob/527e81aff55992be21507e97004286789126f88c/SPEC.md

**Why the OS uses it:** the file format of a domain's knowledge in git (`knowledge/` in each domain
repository: workflows, tacit notes, the operating manual). Any OKF v0.3 consumer can read the
bundle with no OS present.

## Eject test (WP-50)

`os-ui/tabs/knowledge/lib/git/okf-bundle.eject.test.ts` commits a bundle through the OS's own
writer, takes the `knowledge/` tree at that sha, deletes nothing OKF needs, and runs
`python3 -I validate.py <bundle> --strict --json` in the pinned Python image. It must report zero
errors and zero warnings. Its negative twins (a concept without frontmatter; a sub-folder
`index.md` with frontmatter) must fail the same validator.
