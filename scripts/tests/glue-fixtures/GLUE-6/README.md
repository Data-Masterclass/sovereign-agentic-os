# GLUE-6 negative twins

Each file here is refused by a component's own validator. `scripts/tests/validate-generated.test.sh`
runs `scripts/validate-generated.sh --fixtures scripts/tests/glue-fixtures/GLUE-6` and asserts each
step reports `FAIL` for its twin, which proves the step really runs the tool.

- `dbt/twin-duplicate-model.json`: two models named `gold_orders`. `dbt parse` refuses it, and so
  does `dagster definitions validate`, because the code location skips the domain.
- `opa/twin_unused_var.rego`: an assigned variable that is never used. `opa check --strict` refuses it.
- `k8s/twin-bad-deployment.yaml`: `replicas: "two"`. kubeconform refuses it.
