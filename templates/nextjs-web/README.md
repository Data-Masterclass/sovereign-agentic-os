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

## Work from VS Code
This app is a folder in your domain's git repository: `apps/<slug>/`. You can work on it with any editor and plain git.

1. Create a personal access token: OS **Platform > Access tokens > Create token** (shown once; never commit it).
2. Clone: `git clone https://<os-host>/git/<domain>.git`, username anything, password the token. Open `apps/<slug>/` in VS Code.
3. Read `AGENTS.md` (Claude Code reads `CLAUDE.md`, which imports it). These rules are the same ones the in-OS builder follows.
4. Work: `npm ci`, then `npm test`. Before you push run `npm run typecheck && npm run lint && npm test && npm run gates`.
5. Commit and push to `main`: `git push origin main`. Your commits are yours; the OS and the in-OS agent commit to the same folder as themselves. If the push is rejected as non-fast-forward, `git pull --rebase` and push again.

What the OS does with your push: the receive gate refuses changes to platform-owned files (`Dockerfile`, `k8s/`, `.github/workflows/`, `policy/`, `vendor/`, `.npmrc`, `package-lock.json`); the sandbox then runs the same gates as `npm run gates` (type check, lint, tests, OPA policy today; the build is added with the git round-trip) on your commit; showing the result on the app in the Software tab is part of that same go-live (today `verify_app_gates` returns it). A deploy request names the pushed commit and is blocked while a gate is red; Trivy scans it, and a person approves. A push never changes who can see the app and never retires it.

## Eject
Everything here is plain Next.js, Docker and Kubernetes: `docker build .`, then `kubectl apply -f k8s/`.
