# Golden-path rules for nextjs-web@2. Evaluated with OPA (https://www.openpolicyagent.org/docs) over the
# facts that scripts/factory-gates.mjs extracts from the tree. `deny` is a set of messages; empty = pass.
package factory

import rego.v1

source_files := [f | some f in input.files; regex.match(`^src/.*\.(ts|tsx)$`, f.path)]

app_code := [f | some f in source_files; not startswith(f.path, "src/lib/os/")]

# 1. No hand-made authorization outside the OS door.
deny contains msg if {
	some f in app_code
	regex.match(`(?i)(\brole\s*[!=]==?|roleAtLeast\(|\bisAdmin\b|from ['"](jsonwebtoken|jose)['"]|cookies\(\)|headers\(\)\.get\(['"]cookie)`, f.content)
	msg := sprintf("%s: hand-made authorization or identity handling; use src/lib/os and let the OS decide", [f.path])
}

# 2. Governed data only through the SDK: no client or setting of a shared datastore, anywhere.
deny contains msg if {
	some f in source_files
	regex.match(`(?i)(from ['"](mysql2?|mongodb|ioredis|redis|trino-client|@opensearch-project/opensearch|minio|@aws-sdk/[a-z0-9-]+)['"]|process\.env\.(DATABASE|TRINO|OPENSEARCH|MINIO|POSTGRES)\w*)`, f.content)
	msg := sprintf("%s: direct datastore access; read data with os.datasets / os.metrics / os.knowledge, write with os.records", [f.path])
}

# 2b. The app's OWN database (docs/rules/own-database.md) only through src/lib/db/: no other file imports a Postgres
# client or reads the PG* connection variables (pg reads them itself).
db_module(path) if startswith(path, "src/lib/db/")

deny contains msg if {
	some f in source_files
	not db_module(f.path)
	regex.match(`(?i)((from|import)\s*['"](pg|pg-pool|pg-native|pg-cursor|pg-query-stream|postgres|@neondatabase/[a-z0-9-]+|@vercel/postgres)(/[^'"]*)?['"]|(require|import)\(\s*['"](pg|pg-pool|postgres)(/[^'"]*)?['"]|process\.env\.PG\w*|process\.env\[\s*['"]PG)`, f.content)
	msg := sprintf("%s: the app database is reached only through src/lib/db (the one module that imports pg)", [f.path])
}

# 3. Only the SDK reaches the network, and only the OS.
deny contains msg if {
	some f in app_code
	regex.match(`fetch\(\s*['"\x60]https?://`, f.content)
	msg := sprintf("%s: fetch to an absolute URL; the app may reach only the OS, through src/lib/os", [f.path])
}

# 4. No secrets in code or .env files in git.
deny contains msg if {
	some f in input.files
	regex.match(`(?i)(api[_-]?key|secret|password|passwd|token)\w*['"]?\s*[:=]\s*['"][A-Za-z0-9/+_\-]{12,}['"]`, f.content)
	not startswith(f.path, "vendor/")
	msg := sprintf("%s: looks like a hard-coded secret; secrets come from the OS, never from code", [f.path])
}

deny contains msg if {
	some f in input.files
	regex.match(`(^|/)\.env(\..*)?$`, f.path)
	msg := sprintf("%s: environment files do not belong in git", [f.path])
}

# 5. Documentation: the rules files and README exist, and every source file opens with a doc block.
deny contains msg if {
	some p in ["README.md", "AGENTS.md", "CLAUDE.md", "docs/DECISIONS.md"]
	not file_exists(p)
	msg := sprintf("%s is missing", [p])
}

deny contains msg if {
	some f in source_files
	not regex.match(`^\s*/\*\*(?:[^*]|\*+[^*/])*FEATURE:`, f.content)
	msg := sprintf("%s: no doc block with FEATURE:/USER STORY:/ARCHITECTURE: at the top", [f.path])
}

file_exists(p) if {
	some f in input.files
	f.path == p
}

# 6. Tests: every API route is imported by at least one test.
deny contains msg if {
	some f in source_files
	endswith(f.path, "/route.ts")
	stem := trim_suffix(f.path, ".ts")
	not route_tested(stem)
	msg := sprintf("%s: no test imports this route", [f.path])
}

route_tested(stem) if {
	some t in input.files
	startswith(t.path, "tests/")
	contains(t.content, stem)
}

# 7. Every route is declared in openapi.yaml (the operation path mirrors the directory).
deny contains msg if {
	some f in source_files
	endswith(f.path, "/route.ts")
	startswith(f.path, "src/app/api/")
	api := trim_suffix(trim_prefix(f.path, "src/app"), "/route.ts")
	not api in deny_exempt
	not openapi_declares(api)
	msg := sprintf("%s: route %s is not declared in openapi.yaml", [f.path, api])
}

openapi_declares(api) if {
	some f in input.files
	f.path == "openapi.yaml"
	contains(f.content, concat("", ["  ", api, ":"]))
}

# healthz is the platform's probe, not an app function.
deny_exempt := {"/api/healthz"}
