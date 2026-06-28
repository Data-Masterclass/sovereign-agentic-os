# MLflow tracking server + model registry (Apache 2.0), with the Postgres and S3
# drivers the upstream ghcr.io/mlflow/mlflow image omits. Multi-arch base
# (python 3.12-slim builds for amd64 + arm64). The `mlflow server` command line
# is supplied by the Helm chart (templates/science/mlflow.yaml).
FROM python:3.12-slim@sha256:6c4dd321d176d61ea848dc8c73a4f7dbae8f70e0ee48bb411ea2f045b599fa8e

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

RUN useradd -u 1000 -m app
USER 1000

ENV HOME=/tmp
EXPOSE 5000
# The chart passes the full `mlflow server ...` invocation; default to a help
# message so a bare `docker run` is harmless.
ENTRYPOINT ["mlflow"]
CMD ["--help"]
