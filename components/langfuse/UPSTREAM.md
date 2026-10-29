# Langfuse

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** MIT (core; the upstream `ee/` directory is commercially licensed and not enabled)
- **Source:** https://github.com/langfuse/langfuse
- **Pinned as:** Helm chart `langfuse` 1.5.36 (https://langfuse.github.io/langfuse-k8s)

**Why the OS ships it:** Run traces for the Monitoring tab. MIT is what permits offering the OS as a managed service.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.
