# Science TRAINING RUNTIME (Layer 4). A small CPU-only sklearn trainer that reads a
# governed Gold data product THROUGH Trino (a least-privilege BI/science principal),
# trains a model per the ModelSpec (classification: logistic/random-forest,
# regression: linear/random-forest), logs the run to MLflow, and writes
# model.joblib + model-settings.json (mlserver_sklearn.SKLearnModel) for KServe.
#
# Multi-arch base (python 3.12-slim builds for amd64 + arm64). Runs as non-root
# uid 1000. Cross-build for linux/amd64 on Apple Silicon (STACKIT nodes are amd64).
FROM python:3.12-slim@sha256:6c4dd321d176d61ea848dc8c73a4f7dbae8f70e0ee48bb411ea2f045b599fa8e

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

RUN useradd -u 1000 -m app
COPY --chown=1000:1000 train.py /app/train.py
USER 1000

ENTRYPOINT ["python", "/app/train.py"]
