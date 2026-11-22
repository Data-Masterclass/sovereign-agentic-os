# Orders (Sovereign OS golden path: nextjs-web)

A Next.js app that reads and writes governed data, runs an agent, and exposes one function to agents,
all through the OS SDK as the signed-in user.

## Run
    npm ci && npm run dev          # needs OS_BASE_URL (and APP_SLUG) in the environment
    npm run typecheck && npm run lint && npm test && npm run gates

## Layout
- `src/app/**` pages and API routes; `src/lib/**` rules; `src/lib/os/**` the one door to the OS.
- `actions.yml` + `openapi.yaml` the function agents may call (`classify_order`).
- `policy/app-rules.rego` the rules the gates check (OPA).
- `AGENTS.md` / `CLAUDE.md` how to change this app. `docs/DECISIONS.md` why it is built this way.

## Eject
Everything here is plain Next.js, Docker and Kubernetes: `docker build .`, then `kubectl apply -f k8s/`.
