# Superset + psycopg2 (the stock 6.1.0 image lacks the Postgres driver in its
# venv). Installed via uv into /app/.venv so the runtime python finds it.
FROM apache/superset:6.1.0
USER root
RUN uv pip install --python /app/.venv/bin/python --no-cache psycopg2-binary
USER superset
