# MCP test agent

**What it is:** A small agent that proves the OS's own real, governed MCP registry
(`os-ui`'s `/api/mcp`) works end to end — the same way `sample-agent` proves
OpenSearch+RAG works end to end. It runs as a designated demo user, so every tool
call goes through the exact same OPA/role/DLS governance a human using Claude
Desktop would hit. It never hardcodes which tool exists — it asks the live registry
(`tools/list`) at request time.

---

## Step 1 — one-time: complete first-run setup (browser, manual)

Skip this if the account you're using has already done it.

1. Open the os-ui UI in a browser (port-forward it if needed:
   `kubectl -n agentic-os port-forward svc/os-ui 8080:3000`, then visit
   `http://localhost:8080`).
2. Sign in with the bootstrap account: `admin` / `admin`.
3. You'll be forced to set a **real username + email + strong password** —
   do that now.
4. Verify the email (on local-kind the verification link is shown right in the
   UI, no real inbox needed).

No script can do this step for you — it's a one-time, per-account, browser-only
flow. If you skip it, later steps fail with `"Complete first-run setup before
using the platform"`.

## Step 2 — make the scripts executable (one time)

```bash
chmod +x scripts/test-mcp-agent.sh scripts/get-mcp-token.sh
```

## Step 3 — run the test

```bash
./scripts/test-mcp-agent.sh <username> <password> "<question>"
```
Example:
```bash
./scripts/test-mcp-agent.sh <username> <password> "What tools do you have access to?"
```

**What this one command does for you, in order:**
1. Checks if the agent is already Running — if yes, jumps straight to step 6.
2. Builds the Docker image.
3. Loads it into the kind cluster.
4. Logs in as `<username>` and mints an MCP bearer token (auto-starts a
   port-forward to os-ui on `:8080` if needed).
5. Registers a dedicated LiteLLM model (`local-mock`) and grants the agent
   access to it — see **Step 3a** below for why.
6. Deploys/upgrades the agent (`helm upgrade --reuse-values`).
7. Asks your question and prints the JSON result.

**To force steps 2–6 again** even though the agent is already running (e.g.
after an `app.py` change, or to rotate the token), add `--redeploy` as the
first argument:
```bash
./scripts/test-mcp-agent.sh --redeploy <username> <password> "<question>"
```

### Step 3a — why the script registers its own `local-mock` model

The shipped `sovereign-mock` LiteLLM model routes through STACKIT
(`STACKIT_API_KEY`/`STACKIT_API_BASE`). On a local kind cluster that key is
usually empty, so calling `sovereign-mock` fails with an auth error — **this
happens to `sample-agent` too, it is not specific to this agent.** It can also
*look* like it works right after a fresh install and then break later the
moment the `litellm` pod restarts (whatever made it briefly work was never
durable).

So this script never depends on the shared `sovereign-mock` alias — every run
it registers/re-asserts its own dedicated `local-mock` model (wired to the
local `mock-model` service) and makes sure the agent's key can use it. Both
calls are idempotent, so if `litellm` or `os-ui` restarts and resets
something, just re-running the script repairs it.

---

## Verifying it worked

**Check the JSON response** from Step 3 has a real `answer` and a populated
`tools_available` list (dozens of real tool names, not an error).

**Check Langfuse got the trace** (proves this isn't just self-reported):
```bash
kubectl -n agentic-os port-forward svc/agentic-os-langfuse-web 3000:3000 &
curl -s -u "<langfuse public key>:<langfuse secret key>" \
  "http://localhost:3000/api/public/traces?limit=5"
```
You should see your question in `input.messages` in the response.

---

## Doing a step by hand (debugging / non-default setup)

### Minting a token manually
`./scripts/get-mcp-token.sh <username> <password>` logs in, fetches the token,
and prints a ready-to-run `helm upgrade ... --set mcpTestAgent.mcpToken=<token>`
command. Or, fully manual: sign in, open the **MCP** tab in the sidebar, copy
the token shown there (`McpConnect` UI, backed by `/api/mcp/token`), then:
```bash
kubectl -n agentic-os create secret generic mcp-test-agent-token \
  --from-literal=MCP_TOKEN='<the copied token>'
```
Without a token the pod still starts (health stays green); `/ask` fails
honestly (`"MCP_TOKEN not configured"`) instead of silently no-op'ing.

**Token vs. cluster:** a token is signed with that specific deployment's
`OS_MCP_TOKEN_SECRET` — one from one cluster/install will not verify on
another. Mint a fresh one per environment.

### Access without the script (raw HTTP)
```bash
kubectl -n agentic-os run ask --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
  curl -sS -X POST http://mcp-test-agent:8000/ask -H "Content-Type: application/json" \
  -d '{"question": "What tools do you have access to?"}'
```
Returns `answer`, `tools_available` (the live, role-filtered list this account
can see), `tools_called` (empty unless the model actually invoked one), and
`traced_in_langfuse: true`.

### Proving access-control is real (not yet done as of this writing)
Mint a token for a lower-privileged account instead of admin —
`tools_available` should come back as a smaller, role-filtered list, not the
full registry. This is the actual point of the demo: nothing here is a fake or
hardcoded permission check.

### Seeing a real tool actually get called
`local-mock`/`sovereign-mock` never decide to call a tool — they just echo the
prompt back. To see a real `tools/call` happen, register a real,
function-calling-capable model in this cluster's LiteLLM (same `/model/new`
pattern the script uses) and point `mcpTestAgent.chatModel` at it. **Not yet
supported:** pointing this agent at a LiteLLM hosted OUTSIDE this cluster —
`LITELLM_BASE_URL`/`LITELLM_API_KEY` are hardcoded to the in-cluster LiteLLM in
`charts/sovereign-agentic-os/templates/base/example-agents/mcp-test-agent.yaml`,
not values-driven yet; that needs a chart change first.

---

## FAQ

**Q: Login/token minting suddenly fails with credentials that worked before.**
If `os-ui`'s account data isn't on durable storage in your deployment, a pod
restart can reset accounts back to the `admin`/`admin` bootstrap state,
invalidating whatever password/token you had. Redo Step 1 and mint a fresh
token.

**Q: `tools_called` is always empty, even with `local-mock`.** See Step 3a —
it's a dumb echo model by design, not a bug.

**Q: Why not reuse `sample-agent`'s OpenSearch retrieval?** This agent exists
specifically to prove MCP tool-calling, not RAG — it's a separate, simple
component rather than a modification of `sample-agent` (see the PR #39 review
thread that requested it).

**Q: Which model/key does it use?** `local-mock` by default (Step 3a), via the
same scoped agent LiteLLM key `sample-agent` uses (`agent-litellm-key`) — the
script grants that key access to `local-mock` automatically.
