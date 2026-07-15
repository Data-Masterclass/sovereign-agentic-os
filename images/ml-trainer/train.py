#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschraenkt)
"""Science TRAINING RUNTIME (Layer 4) — the parameterized generalization of the
proven kserve-model-seed job.

Reads a governed Gold data product THROUGH Trino (a least-privilege BI/science
principal — never raw creds, never a widened grant), trains a small CPU-only
sklearn model per the model spec (passed as env by lib/science/training.ts),
logs the run to MLflow, and writes model.joblib + model-settings.json to
ARTIFACT_DIR. The os-ui upload sidecar then publishes that dir to
s3://mlflow/models/<model>/, where a per-model KServe InferenceService serves it.

Honest, small algorithm set (NOT AutoML):
  classification -> logistic | random_forest
  regression     -> linear   | random_forest

Every knob comes from env so the SAME image trains any model:
  MODEL_NAME TASK_TYPE ALGORITHM SOURCE_FQN TARGET_COLUMN FEATURES
  TRAIN_TEST_SPLIT OPTIMIZE_METRIC
  TRINO_HOST TRINO_PORT TRINO_USER TRINO_CATALOG
  MLFLOW_TRACKING_URI ARTIFACT_DIR
"""
import json
import os
import sys

import joblib
import numpy as np


def env(name, default=""):
    return os.environ.get(name, default)


def fail(msg):
    print(f"trainer: FATAL {msg}", file=sys.stderr)
    sys.exit(1)


def read_gold(fqn, features, target):
    """SELECT the feature columns (+ target) from the governed Gold table via Trino.

    Identity is the least-privilege TRINO_USER; the Trino->OPA row/column plugin
    enforces what this principal may read. We never widen it here.
    """
    from trino.dbapi import connect

    host = env("TRINO_HOST", "trino")
    port = int(env("TRINO_PORT", "8080"))
    user = env("TRINO_USER", "science-reader")
    catalog = env("TRINO_CATALOG", "iceberg")

    # SOURCE_FQN is `schema.table` under the catalog (e.g. sales.customer_360).
    parts = fqn.split(".")
    if len(parts) == 2:
        schema, table = parts
        qualified = f'"{catalog}"."{schema}"."{table}"'
    elif len(parts) == 3:
        cat, schema, table = parts
        qualified = f'"{cat}"."{schema}"."{table}"'
    else:
        fail(f"SOURCE_FQN must be schema.table or catalog.schema.table, got {fqn!r}")

    cols = list(features) + ([target] if target else [])
    select = ", ".join(f'"{c}"' for c in cols)
    sql = f"SELECT {select} FROM {qualified}"

    conn = connect(host=host, port=port, user=user, catalog=catalog)
    cur = conn.cursor()
    cur.execute(sql)
    rows = cur.fetchall()
    if not rows:
        fail(f"Gold product {fqn} returned no rows for principal {user}")
    data = np.array(rows, dtype=object)
    n_feat = len(features)
    X = data[:, :n_feat].astype(np.float32)
    y = data[:, n_feat].astype(np.float64) if target else None
    return X, y


def build_estimator(task, algorithm):
    from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
    from sklearn.linear_model import LinearRegression, LogisticRegression

    if task in ("binary_classification", "multiclass_classification"):
        if algorithm == "random_forest":
            return RandomForestClassifier(n_estimators=200, max_depth=8, random_state=0), "classification"
        return LogisticRegression(max_iter=500), "classification"
    if task == "regression":
        if algorithm == "random_forest":
            return RandomForestRegressor(n_estimators=200, max_depth=8, random_state=0), "regression"
        return LinearRegression(), "regression"
    fail(f"unsupported TASK_TYPE {task!r} (CPU sklearn: classification + regression only)")


def score(kind, estimator, X, y, metric_name):
    """Return (metric_name, value) for the held-out split — the optimize metric."""
    from sklearn.metrics import (
        accuracy_score,
        f1_score,
        r2_score,
        roc_auc_score,
        root_mean_squared_error,
    )

    if kind == "classification":
        if metric_name == "auc" and len(np.unique(y)) == 2:
            proba = estimator.predict_proba(X)[:, 1]
            return "auc", float(roc_auc_score(y, proba))
        if metric_name == "f1":
            return "f1", float(f1_score(y, estimator.predict(X), average="weighted"))
        return "accuracy", float(accuracy_score(y, estimator.predict(X)))
    # regression
    if metric_name in ("rmse", "mse"):
        return "rmse", float(root_mean_squared_error(y, estimator.predict(X)))
    return "r2", float(r2_score(y, estimator.predict(X)))


def main():
    model_name = env("MODEL_NAME") or fail("MODEL_NAME is required")
    task = env("TASK_TYPE") or fail("TASK_TYPE is required")
    algorithm = env("ALGORITHM", "logistic")
    source_fqn = env("SOURCE_FQN") or fail("SOURCE_FQN is required")
    target = env("TARGET_COLUMN") or None
    features = [f.strip() for f in env("FEATURES").split(",") if f.strip()]
    if not features:
        fail("FEATURES is required (comma-separated feature columns)")
    split = float(env("TRAIN_TEST_SPLIT", "0.8"))
    metric_name = env("OPTIMIZE_METRIC", "auc")
    artifact_dir = env("ARTIFACT_DIR", "/artifact")
    tracking_uri = env("MLFLOW_TRACKING_URI", "")

    print(f"trainer: model={model_name} task={task} algo={algorithm} "
          f"source={source_fqn} features={features} target={target}")

    X, y = read_gold(source_fqn, features, target)
    if y is None:
        fail("this runtime trains supervised models only (a TARGET_COLUMN is required)")

    from sklearn.model_selection import train_test_split

    estimator, kind = build_estimator(task, algorithm)
    X_tr, X_te, y_tr, y_te = train_test_split(X, y, train_size=split, random_state=0)
    estimator.fit(X_tr, y_tr)
    metric_key, metric_val = score(kind, estimator, X_te, y_te, metric_name)
    print(f"trainer: {metric_key}={metric_val:.4f} on {len(X_te)} held-out rows")

    # --- log the run to MLflow (best-effort: a tracking outage never fails the job) ---
    run_id = None
    if tracking_uri:
        try:
            import mlflow

            mlflow.set_tracking_uri(tracking_uri)
            mlflow.set_experiment(model_name)
            # run_name = the k8s Job name so os-ui can look the run up on poll.
            with mlflow.start_run(run_name=env("HOSTNAME", model_name)) as run:
                mlflow.log_params({
                    "task": task, "algorithm": algorithm, "source": source_fqn,
                    "features": ",".join(features), "target": target or "",
                    "train_test_split": split,
                })
                mlflow.log_metric(metric_key, metric_val)
                run_id = run.info.run_id
        except Exception as e:  # noqa: BLE001 — tracking is best-effort
            print(f"trainer: WARN MLflow logging skipped ({e})", file=sys.stderr)

    # --- write the KServe-servable artifact (mlserver_sklearn.SKLearnModel) ---
    os.makedirs(artifact_dir, exist_ok=True)
    joblib.dump(estimator, os.path.join(artifact_dir, "model.joblib"))
    settings = {
        "name": model_name,
        "implementation": "mlserver_sklearn.SKLearnModel",
        "parameters": {"uri": "./model.joblib", "version": "v1"},
    }
    with open(os.path.join(artifact_dir, "model-settings.json"), "w") as f:
        json.dump(settings, f, indent=2)
    print(f"trainer: wrote artifact to {artifact_dir} (run_id={run_id})")


if __name__ == "__main__":
    main()
