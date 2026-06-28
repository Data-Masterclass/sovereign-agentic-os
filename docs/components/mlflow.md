# MLflow — experiment tracking + model registry (Science)

**What it is:** MLflow (Apache 2.0) — **experiment tracking** + **model registry** for Layer-4
traditional ML. Notebooks and the ML agent log params/metrics/models here; trained models are
promoted in the registry and served by KServe. **Off by default** (opt-in Science layer).

Backend store = CloudNativePG **`mlflow`** database; artifact store = the **`mlflow`**
object-storage bucket (MinIO locally / STACKIT Object Storage in prod), served through the
tracking server (`--serve-artifacts`) so clients need only the tracking URL. Custom image
(`sovereign-os/mlflow` = mlflow + psycopg2 + boto3) — the upstream image ships no Postgres/S3
drivers.

## Enable it
Set `mlflow.enabled: true` (pulls in the `mlflow` CNPG DB + bucket automatically) and
`helm upgrade`. Build/load the image first: `make build-images` (or
`docker build -t sovereign-os/mlflow:2.19.0 images/mlflow && kind load docker-image ...`).

## Access
```bash
kubectl -n agentic-os port-forward svc/mlflow 5000:5000
# open http://localhost:5000
```

## Login
No auth locally (in-cluster only; the network baseline is default-deny). Production fronts it
with Ory / an auth proxy.

## Usage
From a JupyterHub notebook:
```python
import mlflow
mlflow.set_tracking_uri("http://mlflow:5000")
mlflow.set_experiment("demo")
with mlflow.start_run():
    mlflow.log_metric("rmse", 0.21)
    mlflow.sklearn.log_model(model, "model", registered_model_name="sample-sklearn")
```
The artifact lands in `s3://mlflow/...`; KServe serves it via its `storageUri`.

## FAQ
**Q: Why a custom image?** `ghcr.io/mlflow/mlflow` lacks `psycopg2` (Postgres backend) and
`boto3` (S3 artifacts) — same custom-image pattern as `sovereign-os/dbt` and `superset`.
**Q: Where's the backend DB?** A `mlflow` database on the shared CNPG cluster
(`postgres.extraDatabases`), credentials in `postgres-mlflow-credentials`.
**Q: arm64?** Yes — the `python:3.12-slim` base is multi-arch, so the image builds natively on
Apple Silicon.
