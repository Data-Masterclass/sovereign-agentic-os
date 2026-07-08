# Cloud configuration (STACKIT) — what you set up in your cloud

Locally everything is self-contained (Mode A). To run on **STACKIT** (or any cloud), you
switch specific backends to managed services (Mode B) and provide real secrets. Same chart —
mode is only a values choice (`values.stackit-managed.yaml`).

## 0. Prerequisites in your cloud account
- A **STACKIT organization + project** (region **EU01 / Deutschland Süd**).
- A **service-account key with provisioning roles** (SKE + Object Storage + DNS). Save as
  `stackit/sa-key.json` (gitignored). This is the gate for any live deploy.
- Tooling: STACKIT CLI **or** Terraform (`stackitcloud/stackit`), plus `kubectl`, `helm`, `argocd`.

## 1. Provision the managed resources (Terraform preferred)
| Resource | Why |
|---|---|
| **SKE cluster** (CNI = Cilium) | the runtime + FQDN-aware egress |
| **Node pool** (≈3× g1.4 for L1+L2, 4–5× for L3) | worker capacity (RAM-bound) |
| **Object Storage** buckets + S3 credentials | Iceberg lake, Langfuse blobs, Velero backups |
| **Load balancer + public IP** | ingress |
| **DNS zone / records** | the OS UI + per-domain subdomains |
| **Secrets Manager / KMS** | the secrets backend (recommended) |

Get a kubeconfig: `stackit ske kubeconfig create --cluster dm-agentic-os > kubeconfig.yaml`.

## 2. In-cluster platform (bootstrap, before the OS chart)
ingress-nginx + cert-manager · the SKE storage class · Cilium default-deny egress ·
**External Secrets Operator** · **CloudNativePG** operator · Velero · Argo CD.

## 3. Configure the OS for managed backends
Edit `values.stackit-managed.yaml` (or let `install.sh` write `values.generated.yaml`):
- **Object storage** → STACKIT Object Storage endpoint + an `object-storage-credentials`
  secret (via External Secrets), `objectStorage.enabled: false`.
- **Postgres** → STACKIT Postgres Flex (or keep CloudNativePG in-cluster).
- **LLM** → **STACKIT AI Model Serving** (`llm.mode: external`, `provider: stackit`,
  `secretRef: stackit-ai-model-serving-key`), or an API key for another OpenAI-compatible provider.
- **Ingress hostnames + TLS issuer**, the **egress allowlist**, per-domain quotas.

## 4. Secrets — never in git
All real credentials live in **STACKIT Secrets Manager / KMS** and are synced by **External
Secrets Operator**. The chart references secrets by name only. The local dev passwords you
see in the Admin Console do **not** apply on STACKIT.

## 5. Deploy + verify
```bash
helm install agentic-os charts/sovereign-agentic-os -n agentic-os --create-namespace \
  -f values.stackit-managed.yaml -f values.generated.yaml
```
Point DNS at the load balancer (cert-manager issues TLS). Verify the consoles, confirm the
default-deny egress baseline is active, then configure the first domain space(s).

## Cost & scaling
~€450–670/mo for L1+L2 at typical sizing; **scale the node pool to zero between sessions**
(storage + IP persist ~€16–20/mo). LLM token spend is separate and **capped in LiteLLM**.

## FAQ
**Q: Do I have to use STACKIT?** No — any Kubernetes works (the chart is portable). STACKIT
is the sovereign EU default; the managed-services mapping is STACKIT-specific.

**Q: Can I mix bundled + managed?** Yes — per backend. e.g. managed Postgres but bundled
OpenSearch. The `mode: bundled|external` toggle is per component.

**Q: What needs the SA key?** Only the real provision/deploy. You can build + validate the
entire chart on local kind with no key.
