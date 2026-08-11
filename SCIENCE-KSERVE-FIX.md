# SCIENCE-KSERVE-FIX — the Science "Publishing" failure is a cluster serving-runtime defect

**Status:** os-ui code is correct. The publish failure is a **cluster-side KServe serving-runtime
misconfiguration** that a platform admin must fix. This doc is the exact change to apply.

## Symptom

Launching any model gets through **Training** (MLflow + Dagster healthy) and dies at
**Publishing** (the KServe deploy). The predictor pod is in `CrashLoopBackOff` with:

```
exec: "--model_name=<isvc-name>": executable file not found in $PATH
```

i.e. the model-name *flag* is being run as the *executable*. The only KServe predictor in the
cluster (`sample-sklearn-predictor`, the seeded demo) shows exactly this.

## Root cause (definitive)

os-ui builds a **declarative** InferenceService (`os-ui/lib/science/deploy.ts` →
`buildInferenceService`):

```yaml
spec:
  predictor:
    model:
      modelFormat: { name: sklearn }
      protocolVersion: v2                       # Open Inference Protocol (/v2/models/<m>/infer)
      storageUri: s3://mlflow/models/<model>
metadata:
  labels:
    modelClass: mlserver_sklearn.SKLearnModel   # the kserve-mlserver runtime templates its impl from this
```

This spec deliberately carries **no container `command`/`args`** — the *serving runtime* supplies
them. It selects a **v2 MLServer** runtime (`protocolVersion: v2` + the `mlserver_sklearn` modelClass),
exactly matching the chart's sample (`charts/.../science/kserve.yaml`) and the trainer/seed image
(`seldonio/mlserver:1.5.0`).

The crash means the intended **v2 `kserve-mlserver` `ClusterServingRuntime` is NOT installed** on
the cluster. With it absent, KServe falls back to its built-in **v1 `kserve-sklearnserver`** runtime,
whose container is `python -m sklearnserver` with args `--model_name={{.Name}} --model_dir=…`. When
that runtime is itself mis-rendered/mismatched, the `--model_name=…` arg lands in the `command`
position → `exec: "--model_name=…": executable file not found in $PATH`.

Grep confirms **no `ClusterServingRuntime`/`ServingRuntime` object ships in this repo** — like the
KServe controller itself, the serving runtimes are a **bootstrap prerequisite** installed before the
OS chart (`charts/.../science/kserve.yaml` header: *"operators are bootstrap, not bundled in the
release"*). That bootstrap is missing or wrong on the affected cluster.

**This is NOT an os-ui bug.** Every real deploy shares the same correct spec, so every publish fails
at the same place until the runtime is installed. os-ui was updated (0.6.100) to *detect* this crash
(predictor pod probe) and surface a clear **"Serving runtime misconfigured — see admin"** error +
ground the launch assistant in it, instead of a generic "failed".

## The fix (platform admin)

Install the v2 MLServer serving runtimes that ship with KServe. On a standard KServe install these
are applied by the `kserve` chart's `servingruntimes` (cluster-scoped). If they are missing, apply
the upstream cluster runtimes for your KServe version, e.g.:

```bash
# KServe ships its ClusterServingRuntimes in the release manifests. Reapply them
# (pin the tag to YOUR installed KServe version — release-0.13 shown as an example):
kubectl apply -f \
  https://raw.githubusercontent.com/kserve/kserve/release-0.13/config/runtimes/kserve-mlserver.yaml

# Verify the v2 mlserver runtime now exists and supports sklearn + protocolVersion v2:
kubectl get clusterservingruntime kserve-mlserver -o yaml | \
  grep -E 'name:|protocolVersions|modelFormat|image'
```

The `kserve-mlserver` `ClusterServingRuntime` must:
- list `sklearn` (and `xgboost`, `lightgbm`) under `spec.supportedModelFormats`,
- declare `protocolVersions: [v2]`,
- run the MLServer container `mlserver start ${MODELS_DIR}` (NOT `--model_name=…` as the executable),
- template `MLSERVER_MODEL_IMPLEMENTATION` from `{{.Labels.modelClass}}`.

Pin the runtime image to the SAME MLServer the trainer/seed uses so the pickled sklearn model is
version-safe (`charts/.../values.yaml` → `kserve.seed.trainImage`: `seldonio/mlserver:1.5.0`).

After applying, KServe reconciles existing InferenceServices automatically; new predictor pods start
clean. In os-ui the model's **Retry** (re-enabled once the runtime is healthy) or the next deploy
poll flips it `deployed`.

## Remove the stale seeded `sample-sklearn-predictor` (optional, demo leftover)

The crash-looping `sample-sklearn` InferenceService is the seeded demo
(`charts/.../science/kserve.yaml` + `kserve-model-seed.yaml`, values `kserve.sampleModel` /
`kserve.seed`). It is chart-owned, so **manage it through Helm**, not `kubectl delete` (a bare delete
is re-created on the next `helm upgrade`):

```bash
# Turn the sample + its seed job off (they exist only to demo a served model):
helm upgrade <release> <chart> --reuse-values \
  --set kserve.seed.enabled=false \
  --set kserve.sampleModel.name=""      # or drop the sample block in values

# Or, once the runtime is fixed, let it recover on its own — it serves churn_model at
# /v2/models/churn_model/infer and stops crash-looping the moment kserve-mlserver exists.
```

Either way the stale sample must not mask the real-model path: the runtime fix above is what unblocks
user launches.
