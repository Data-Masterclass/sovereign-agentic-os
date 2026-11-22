# Tekton (Pipelines, Triggers, Catalog)

Upstream, unmodified. Nothing in this folder is ours beyond the pin and the installer — see the rule in
`components/README.md`. These are platform components with their own versions, separate from the chart.

- **Licence:** Apache-2.0 for Pipelines, Triggers and the Catalog.
  - Pipelines: https://github.com/tektoncd/pipeline/blob/v1.15.5/LICENSE
  - Triggers: https://github.com/tektoncd/triggers/blob/v0.36.5/LICENSE
  - Catalog: https://github.com/tektoncd/catalog/blob/main/LICENSE
- **Pinned as** (see `scripts/tekton/versions.env`; every manifest is sha256-checked by `install.sh`):
  - Tekton Pipelines `v1.15.5` (an LTS line) — `https://infra.tekton.dev/tekton-releases/pipeline/previous/v1.15.5/release.yaml`;
    its controller, webhook, resolvers and entrypoint images are pinned by digest inside that manifest.
  - Tekton Triggers `v0.36.5` + core interceptors — `https://infra.tekton.dev/tekton-releases/triggers/previous/v0.36.5/{release,interceptors}.yaml`.
  - Catalog tasks, vendored byte-for-byte from `tektoncd/catalog` commit `112374ce…`: `git-clone` 0.10 and
    `trivy-scanner` 0.2 (under `charts/sovereign-agentic-os/files/tekton/tasks/`; sha256 in `scripts/tekton/versions.env`).
- **Docs used:**
  - Install: https://tekton.dev/docs/installation/pipelines/ and https://tekton.dev/docs/installation/triggers/
  - Feature flag `set-security-context`: https://tekton.dev/docs/pipelines/additional-configs/
  - Git resolver (`pipelineRef.resolver: git`): https://tekton.dev/docs/pipelines/git-resolver/
  - Cancel a run with `spec.status: Cancelled`: https://tekton.dev/docs/pipelines/pipelineruns/#cancelling-a-pipelinerun
  - Step `onError: continue` and `$(steps.<name>.exitCode.path)`: https://tekton.dev/docs/pipelines/tasks/#specifying-onerror-for-a-step
  - Sidecars: https://tekton.dev/docs/pipelines/tasks/#specifying-sidecars
  - Pipeline-task workspace `subPath`: https://tekton.dev/docs/pipelines/pipelines/#specifying-workspaces
  - EventListener, TriggerBinding, TriggerTemplate, CEL interceptor: https://tekton.dev/docs/triggers/
  - Pruning: https://tekton.dev/docs/pipelines/pipelineruns/ (`tkn pipelinerun delete --keep`)
- **Images the pipeline runs** (all Apache-2.0 or MIT/BSD-style, licence-scanned in the PR with Trivy):
  Node (MIT) `node:22-alpine3.24`, OPA (Apache-2.0) `openpolicyagent/opa:1.22.4`, Trivy (Apache-2.0)
  `aquasec/trivy:0.58.2` (the same pin as the deploy scanner), `ghcr.io/tektoncd-catalog/git-clone:v1.1.0`
  (Apache-2.0, the Catalog's git-init), `ghcr.io/tektoncd/plumbing/tkn` (Apache-2.0, run history pruning).

**Why the OS uses it:** the Software Factory's per-commit checks and (go-live 2) the image build run as
Tekton PipelineRuns. The pipeline of an app lives in git at `apps/<slug>/.tekton/pipeline.yaml`; the OS
starts runs through a Triggers EventListener, reads PipelineRun/TaskRun status and logs through Kubernetes,
and fills the engine-neutral per-commit record (`check-record.ts`). Deploy stays in the OS (no Argo CD).

**Install:** `bash scripts/tekton/install.sh --context <ctx>`, then enable `osUI.software.tekton`
in the chart. The chart ships only the OS-owned resources (namespace, RBAC, NetworkPolicies, listener,
quotas, pruner).

## Known gaps (tracked follow-ups)

- **Pod Security.** The build namespace enforces `baseline` and audits/warns `restricted`. The Catalog `git-clone`
  step sets a partial securityContext, which Tekton's `set-security-context` leaves as written, so `restricted`
  would refuse it. The pods that run the app's code are restricted-compliant (asserted by the kind e2e). Follow-up:
  patch or replace the clone step, then enforce `restricted`.
- **git-http read from the cluster is unauthenticated.** The in-cluster `os-git-http` Service has no auth of its own
  (the ingress authenticates outside callers). NetworkPolicies admit only the clone step and the Tekton resolver
  pods from the build side. Follow-up: a read-only, per-run credential (token in a Secret for the clone step and the
  git resolver) checked by `/api/git/authenticate`.
- **Licence scan of the Tekton, Zot and BuildKit images with Trivy** is to be attached to the PR (Zot and BuildKit
  arrive with go-live 2).
