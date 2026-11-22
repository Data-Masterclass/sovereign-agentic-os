@AGENTS.md

# Claude Code specifics
- Read `AGENTS.md` first; it is the rulebook. This file only adds how to work with the OS tools.
- Start from the OS: call `get_app_template` for the current rules, `get_app_spec` for what to build.
- Work in a clone of this app's git repository. Commit small changes; run `npm test` before each commit.
- Before asking for a deploy, call `run_app_tests` (the OS runs the same gates in its sandbox), fix what it reports, then `request_deploy`. A person approves; you cannot.
- Never run `npm run lint` with `--fix` on files you did not change, and never edit `vendor/`.
