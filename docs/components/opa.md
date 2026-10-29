# OPA — policy at the tool boundary

**What it is:** Open Policy Agent (Apache 2.0) makes **default-deny** authorization decisions
for tool use: a principal (a LiteLLM key / agent identity) may invoke a tool only if it's
granted. Internet tools (`web_fetch`) are intentionally not granted by default — the
"deny internet tools unless granted" baseline (security.md).

## Access (decision API)
```bash
kubectl -n agentic-os port-forward svc/opa 8181:8181
curl http://localhost:8181/v1/data/agentic/authz/allow \
  -d '{"input":{"principal":"sovereign-agents","tool":"web_fetch"}}'   # -> {"result":false}
curl http://localhost:8181/v1/data/agentic/authz/allow \
  -d '{"input":{"principal":"sovereign-agents","tool":"query"}}'       # -> {"result":true}
```

## How to use it
- **Grants** live in `opa.grants` (values): principal → allowed tools. e.g. `sovereign-agents`
  → `rag_search, llm_generate, query`; `sovereign-agents-web` adds `web_fetch`.
- The **governed web_fetch tool** consults OPA before every fetch.

## FAQ
**Q: How do I grant a tool?** Add it under the principal in `opa.grants`, then `helm upgrade`.
**Q: Does OPA gate models too?** Tool access here; model/key caps are enforced in LiteLLM. In
production OPA also covers row/column data policies.
**Q: Why default-deny?** Least privilege — unknown principals/tools are denied unless explicitly allowed.
