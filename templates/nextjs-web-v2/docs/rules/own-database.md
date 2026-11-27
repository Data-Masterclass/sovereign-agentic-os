# The app's own database, env and secrets

<!-- Owner: App Builder workstream D. Until D fills this page, the rules below are the v1 data and configuration
     rules, unchanged: this app has no database of its own yet. -->

- Read data only with `os.datasets.query`, `os.metrics.query`, `os.knowledge.search`, `os.files.*`. Write only with
  `os.records.*`.
- Never connect to Trino, OpenSearch, MinIO, Postgres or any datastore directly, and never take a datastore URL or
  password.
- Run agents with `os.agents.run`; if the run is `parked`, show that it waits for approval. Do not fake an answer.
- The only configuration the app reads is `OS_BASE_URL` and `APP_SLUG`, set by the platform. Anything secret comes
  from the OS; ask for it, do not invent an env var.
