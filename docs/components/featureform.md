# Featureform — virtual feature store (Science)

**What it is:** Featureform (**MPL-2.0**) — a **virtual** feature store for Layer-4 ML. It
defines and serves reusable ML **features** on top of existing infra rather than copying data:
**offline** = Iceberg via central Trino (over Polaris), **online** = **Valkey**
(BSD-3 — the stack's cache, *not* Redis). **Off by default** (optional Science component).

## Enable it
Set `featureform.enabled: true` and `helm upgrade`. See the arm64 note below before running on
Apple Silicon.

## Access
```bash
kubectl -n agentic-os port-forward svc/featureform 7878:7878 8080:80
# API/gRPC :7878 ; dashboard http://localhost:8080
```

## Login
No auth locally (in-cluster only). Providers (Valkey online, Iceberg offline) are registered
from a notebook or the ML agent with the Featureform client.

## Usage
```python
import featureform as ff
client = ff.Client(host="featureform:7878", insecure=True)
# register a Valkey online store + an Iceberg offline source, then a feature/training set
```
Features serve online from Valkey; the ML agent reads them when training (MLflow) and at
inference (KServe).

## FAQ
**Q: Why Featureform over Feast?** Its *virtual* model fits the sovereign stack (sits atop our
Iceberg + Valkey, no data copy). MPL-2.0 is genuine open source, bundleable.
**Q: arm64?** Yes — `featureformcom/featureform:0.15.10` is multi-arch (amd64 + arm64,
verified), so it runs natively on Apple Silicon.
**Q: Do I need it for ML?** No — it's optional. Cube + dbt cover most "consistent, governed
definitions" needs; add Featureform when you need an **online** feature store for serving.
