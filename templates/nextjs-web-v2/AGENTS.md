# AGENTS.md - rules for building this app (humans and coding agents)

This is a Sovereign OS golden-path app (template `nextjs-web@2`, the App Builder template). The same rules bind the
in-OS coding agent and an external tool such as Claude Code. The platform gates check them; a red gate blocks deploy.

This file is the INDEX. Sections 1-5 and 9-10 are the rules themselves; the topics that grew their own page are in
`docs/rules/` and each section below says which page wins. When this file and a `docs/rules/` page disagree, the page
wins and this file is the one to fix.

| Topic | Rule page |
|---|---|
| User stories, acceptance criteria and the tests that prove them | [`docs/rules/stories-and-tests.md`](docs/rules/stories-and-tests.md) |
| The app's own database, migrations, env and secrets | [`docs/rules/own-database.md`](docs/rules/own-database.md) |
| Identity, sign-in and authorization | [`docs/rules/identity.md`](docs/rules/identity.md) |

## 1. Language rules
- TypeScript only, `strict` on. No `any` (lint error), no `@ts-ignore`, no `console.*` (lint error).
- Node 22, Next.js App Router. Server code uses Web `Request`/`Response`, not Node-only APIs, so handlers stay unit-testable.
- Add a dependency only when the task needs it: pin an exact version, licence Apache-2.0/MIT/BSD/ISC, and say why in `docs/DECISIONS.md`.
- Never change `@sovereign-os/app-sdk`, `vendor/`, `.npmrc` or `package-lock.json` by hand.

## 2. Code structure
- `src/app/**` routes and pages only: parse input, call a function in `src/lib`, shape the response. Keep them under ~60 lines.
- `src/lib/**` business rules as pure functions. One concern per file.
- `src/lib/os/**` is the only code that talks to the OS. Nothing else imports the SDK client.
- One route per directory: `src/app/api/<name>/route.ts`. Every route is declared in `openapi.yaml`.
- A new feature is a new file next to its siblings, never a growing `page.tsx`.

## 3. Code documentation
- Every source file starts with a `/** */` block with `FEATURE:`, `USER STORY:` and `ARCHITECTURE:` lines.
- `README.md` says what the app does and how to run it. `docs/DECISIONS.md` records each non-obvious choice in one paragraph.
- Update the docs in the same change as the code.

## 4. Unit tests (required)
- `npm test` must be green. Tests live in `tests/*.test.ts` (node:test, no browser).
- How tests relate to user stories and acceptance criteria: [`docs/rules/stories-and-tests.md`](docs/rules/stories-and-tests.md).

## 5. Security rules
- Never write a secret, token, password or key in code, config or tests. No `.env` files in git.
- Validate every request body before use; return 400 with a reason, never a stack trace.
- No `eval`, no `dangerouslySetInnerHTML`, no raw HTML from data.
- No calls to hosts outside the OS (`fetch('https://...')`). The platform network policy blocks them anyway.
- Do not edit platform-owned files: `Dockerfile`, `k8s/**`, `.github/workflows/**`, `.tekton/**`, `next.config.mjs`, `policy/**`, `scripts/factory-gates.mjs`, `vendor/**`, `.npmrc`, and any further path the platform lists for this template (`get_app_template` returns the list). A push that changes one is refused, and the gates are judged by the platform's copies of the policy and the gates script, not yours.

## 6. Identity and authorization
See [`docs/rules/identity.md`](docs/rules/identity.md).

## 7. Data access
- Governed shared data (datasets, metrics, knowledge, files, records, agents): only through the OS SDK in `src/lib/os`.
- The app's own database: see [`docs/rules/own-database.md`](docs/rules/own-database.md).

## 8. Secrets and configuration
See [`docs/rules/own-database.md`](docs/rules/own-database.md) (env, secrets and the database connection are set by the
platform; never invent an env var and never write a value into git).

## 9. Exposing a function to agents
- Declare it in `actions.yml` (name, description, `write`, `scopes`, input), describe it in `openapi.yaml` with a matching `operationId`, and implement a pure rule plus a thin route. The OS authorizes and traces each call.

## 10. Definition of done
`npm run typecheck && npm run lint && npm test && npm run gates` all pass. The gates are the same ones the platform runs before deploy.
