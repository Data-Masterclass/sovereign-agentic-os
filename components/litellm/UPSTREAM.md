# LiteLLM

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** MIT
- **Source:** https://github.com/BerriAI/litellm
- **Pinned as:** Helm chart `litellm-helm` 1.90.0 (oci://ghcr.io/berriai)

**Why the OS ships it:** The only model gateway: virtual keys, budgets, routing to the configured provider.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.
