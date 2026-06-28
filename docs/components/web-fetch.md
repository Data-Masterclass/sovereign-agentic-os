# Governed web_fetch tool

**What it is:** The **only sanctioned path to the web**. Every fetch is (1) authorized by OPA
per principal, (2) routed through the **egress proxy** (domain allowlist applies), and
(3) returned as **sanitized data** — never instructions (prompt-injection defense). Agents get
no raw internet; outbound is granted, proxied, allowlisted, audited.

## Access
```bash
kubectl -n agentic-os run wf --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
  curl -sS http://web-fetch:8000/fetch -H "Content-Type: application/json" \
  -d '{"principal":"sovereign-agents-web","url":"https://api.github.com"}'
```

## Behaviour (validated)
| Principal | URL | Result |
|---|---|---|
| `sovereign-agents` (no web grant) | any | **403** — OPA denies |
| `sovereign-agents-web` | allowlisted (github.com) | **200** — fetched via proxy |
| `sovereign-agents-web` | non-allowlisted (google.com) | **502** — proxy blocks |

## FAQ
**Q: How do I allow a domain?** Add it to `egressProxy.allowlist` (see Egress proxy doc).
**Q: How do I grant an agent web access?** Add `web_fetch` to its principal in `opa.grants`.
**Q: Is fetched content safe to feed the model?** It's stripped of markup and treated as data;
never auto-write web content into the knowledge base without review.
