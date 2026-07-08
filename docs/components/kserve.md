# KServe — model serving / inference (Science)

**What it is:** KServe (Apache 2.0) — **model serving / inference** for Layer-4 ML. It pulls a
trained model from the MLflow registry (stored in the `mlflow` object-storage bucket) and
serves it behind a stable endpoint. CPU by default; a GPU node pool is opt-in. **Off by
default** (opt-in Science component). Seldon Core was rejected (BSL — non-production).

## Prerequisite (bootstrap)
The **KServe controller + cert-manager** are a cluster-scoped bootstrap, installed **before**
the OS chart — exactly like the CloudNativePG operator. We use **RawDeployment mode** (plain
k8s Deployment/Service — *no* Knative):
```bash
helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace \
  --set crds.enabled=true
helm install kserve oci://ghcr.io/kserve/charts/kserve -n kserve --create-namespace \
  --set kserve.controller.deploymentMode=RawDeployment
```
The OS chart ships only the namespaced **InferenceService** CR.

## Enable it
Set `kserve.enabled: true` (after the controller is installed) and `helm upgrade`. Point
`kserve.sampleModel.storageUri` at a real model path in the `mlflow` bucket.

## Access
```bash
kubectl -n agentic-os get inferenceservice sample-sklearn
kubectl -n agentic-os port-forward svc/sample-sklearn-predictor 8081:80
curl -X POST http://localhost:8081/v1/models/sample-sklearn:predict -d @input.json
```

## FAQ
**Q: Why RawDeployment?** It avoids the heavy Knative/Istio dependency — KServe runs as plain
Deployments, fine for the lab and a lean prod.
**Q: Where does the model come from?** The MLflow registry; the artifact lives in
`s3://mlflow/...` and KServe's storage-initializer fetches it using `kserve-s3-credentials`.
**Q: arm64?** The InferenceService is just a CR (arch-neutral). The KServe controller images
and the model-serving runtimes (sklearn/MLServer) are multi-arch.
**Q: GPU?** Add a GPU node pool + GPU resource requests on the predictor; CPU-only by default.
