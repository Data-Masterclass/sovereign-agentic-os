# Adding a second node (owner decision O6)

The platform runs on one SKE worker today (`m3i.8`: 7,910m CPU and 52.6 GiB allocatable). The
capacity gate (`scripts/check-capacity.mjs`, budget in `charts/sovereign-agentic-os/capacity.yaml`)
fails a chart change that would push CPU or memory requests, or memory limits, above 85 % of that.
When planned additions no longer fit, the second node is the precondition for them (00 §10.1, 10 F9).

Ordering the node is the owner's action in the STACKIT project. This page is the change that goes
with it. **Do not run it without the owner.**

## Before you start

- `deploy/terraform/ske.tf` documents a known limitation: on SKE inside a STACKIT Network Area,
  pods on a node without a CoreDNS replica could not reach DNS or pods on other nodes. Get
  STACKIT's confirmation that cross-node pod networking works for this cluster, or the second node
  will break the Postgres-backed components as it did on the first multi-node attempt.
- Take a Velero backup first (`docs/backups.md`).

## The change: node pool only, `-target` only

The node pool is driven by variables; no Terraform code changes. In the operator's
`deploy/terraform/terraform.tfvars`:

```hcl
node_pool_min = 2
node_pool_max = 2
```

Then plan and apply **only** the cluster resource. Never run a plain `tofu apply` on this stack.

```bash
cd deploy/terraform
tofu plan  -target=stackit_ske_cluster.this -out=second-node.plan
# Read the plan: the only change must be node_pools[0].minimum/maximum on stackit_ske_cluster.this.
# Anything else in the plan (a machine_type change rolls the existing node) → stop.
tofu apply second-node.plan
```

Moving to a bigger flavour (`m3i.16`) instead is the same `-target` change with `node_machine_type`.
It replaces the existing node, so it is a maintenance window, not a background change.

## After the node is Ready

1. `kubectl --context dmagenticos get nodes` shows two Ready workers.
2. Update `charts/sovereign-agentic-os/capacity.yaml`: `node.count: 2` (and `allocatable` if the
   flavour differs). Merge it through a PR. The gate then budgets 2 × allocatable, and counts the
   kube-system DaemonSets once per node.
3. Add PodDisruptionBudgets for the stateful sets (Postgres, OpenSearch) in the same PR. On one
   node a `minAvailable: 1` PDB on a single replica would block every node drain, which is why
   they are not there yet.
4. Live evidence: `node scripts/check-capacity.mjs --profile default --compare-live dmagenticos`
   prints the prediction next to the live node totals; it fails if they differ by more than 5 %.

## Rollback

Set `node_pool_min`/`node_pool_max` back to `1` and run the same `-target` plan and apply. The
scheduler moves the pods back on the one node; check the gate still passes for `node.count: 1`
first.
