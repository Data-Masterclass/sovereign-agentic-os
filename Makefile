# Sovereign Agentic OS — local first. See README.md.
.PHONY: up down test lint
up:     ## Run the OS on your machine (kind): build images, install chart, print URL
	./scripts/os up
down:   ## Delete the local cluster
	./scripts/os down
test:   ## Unit tests + regression gate + chart lint (+ health when up)
	./scripts/os test
lint:   ## helm lint (local profile)
	helm lint charts/sovereign-agentic-os -f values.local.yaml
