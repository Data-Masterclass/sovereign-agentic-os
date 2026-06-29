# Superset + psycopg2 (Postgres: the Superset metadata DB) + the Trino SQLAlchemy
# dialect (so Superset reads the governed marts THROUGH central Trino). The stock
# 6.1.0 image ships neither in its venv. Installed via uv into /app/.venv so the
# runtime python finds them.
FROM apache/superset:6.1.0
USER root
RUN uv pip install --python /app/.venv/bin/python --no-cache \
      psycopg2-binary \
      "trino[sqlalchemy]"
USER superset
