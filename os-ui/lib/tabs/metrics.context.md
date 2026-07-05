# Metrics tab — build context

**Purpose:** One definition of every number. A metric is a governed Cube member defined on a dataset’s built GOLD version — define-here / explore / chart / ask-the-agent all read the identical number.

**Tools (MCP `metrics`):**
- `define_metric(datasetId, name, aggregation, column?, dimensions?)` — persist a measure on a Gold, GOVERNED (asset/product) dataset. Returns the canonical member + generated Cube YAML.

**Golden path:** in Data, build a Gold version, file `request_promotion` (kind `"dataset"`), a Builder runs `approve_promotion` → `define_metric` here → chart it with `create_dashboard`.

**Constraints:** the dataset must already be a governed asset/product (promote it in Data first — Cube reads the Trino mart). `count` needs no column; every other aggregation needs a Gold column. Runs as you; audited.
