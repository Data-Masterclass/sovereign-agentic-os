# AGENTS.md - rules for building this app (humans and coding agents)

This is a Sovereign OS golden-path app (template `nextjs-web`). The same rules bind the in-OS coding
agent and an external tool such as Claude Code. The platform gates check them; a red gate blocks deploy.

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
- Every route file under `src/app/api` is imported by at least one test, and every function in `src/lib` has a test of its rule, including the failing input.
- Write the failing test first, then the code. A bug fix starts with a test that reproduces it.
- Tests use injected `fetch`, never the network and never a real OS.

## 5. Security rules
- Never write a secret, token, password or key in code, config or tests. No `.env` files in git.
- Validate every request body before use; return 400 with a reason, never a stack trace.
- No `eval`, no `dangerouslySetInnerHTML`, no raw HTML from data.
- No calls to hosts outside the OS (`fetch('https://...')`). The platform network policy blocks them anyway.
- Do not edit platform-owned files: `Dockerfile`, `k8s/**`, `.github/workflows/**`, `next.config.mjs`, `policy/**`, `scripts/factory-gates.mjs`, `vendor/**`, `.npmrc`. A push that changes one is refused, and the gates are judged by the platform's copies of the policy and the gates script, not yours.

## 6. Identity and authorization: the OS decides
- Identity is the signed-in user, delegated by the OS. Get it from `src/lib/os` (`asCaller`, `requireUser`).
- Do NOT write your own authorization: no role comparisons, no `isAdmin`, no JWT or cookie parsing, no allow-lists of users. The OS checks every SDK call (OPA); a refusal arrives as `Forbidden` and you pass it on.
- Background work as the app itself is not available until a domain admin approves an app identity.

## 7. Data access
- Read data only with `os.datasets.query`, `os.metrics.query`, `os.knowledge.search`, `os.files.*`. Write only with `os.records.*`.
- Never connect to Trino, OpenSearch, MinIO, Postgres or any datastore directly, and never take a datastore URL or password.
- Run agents with `os.agents.run`; if the run is `parked`, show that it waits for approval. Do not fake an answer.

## 8. Secrets and configuration
- The only configuration the app reads is `OS_BASE_URL` and `APP_SLUG`, set by the platform. Anything secret comes from the OS; ask for it, do not invent an env var.

## 9. Exposing a function to agents
- Declare it in `actions.yml` (name, description, `write`, `scopes`, input), describe it in `openapi.yaml` with a matching `operationId`, and implement a pure rule plus a thin route. The OS authorizes and traces each call.

## 10. Definition of done
`npm run typecheck && npm run lint && npm test && npm run gates` all pass. The gates are the same ones the platform runs before deploy.
