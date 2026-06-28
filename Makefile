# Sovereign Agentic OS — convenience targets.
.PHONY: install install-defaults uninstall images lint template

install:           ## Interactive install wizard (bundled vs managed per backend)
	./install.sh

install-defaults:  ## Non-interactive, fully self-contained install (all bundled)
	./install.sh --defaults

uninstall:         ## Remove the release (keeps the cluster)
	./install.sh --uninstall

images:            ## Build + load the bespoke images into kind
	./scripts/build-images.sh

lint:              ## helm lint
	helm lint charts/sovereign-agentic-os -f values.selfcontained.yaml

template:          ## render + client-validate
	helm template agentic-os charts/sovereign-agentic-os -f values.selfcontained.yaml | kubectl apply --dry-run=client -f -

# --- STACKIT Mode B (full managed stack) — passthrough to deploy/Makefile -----
# The deploy automation (Terraform + Argo CD app-of-apps) lives in deploy/.
# These delegate so `make stackit-up` etc. work from the repo root.
# See deploy/README.md. Run for real only at go-live (cost-gated).
.PHONY: stackit-validate stackit-up stackit-down stackit-sleep stackit-wake \
        stackit-sync stackit-images

stackit-validate:  ## terraform validate + fmt-check (local, no STACKIT calls)
	$(MAKE) -C deploy validate

stackit-up:        ## Provision + GitOps-deploy the full managed stack (go-live)
	$(MAKE) -C deploy stackit-up CONFIRM=$(CONFIRM)

stackit-down:      ## Prune workloads + destroy all STACKIT infra
	$(MAKE) -C deploy stackit-down CONFIRM=$(CONFIRM)

stackit-sleep:     ## Scale the SKE node pool to 0 (08:00–20:00 cost window)
	$(MAKE) -C deploy sleep

stackit-wake:      ## Scale the SKE node pool back up
	$(MAKE) -C deploy wake

stackit-sync:      ## Trigger an Argo CD sync
	$(MAKE) -C deploy sync

stackit-images:    ## Build + push bespoke images to the STACKIT registry (dry-run; ARGS=--push)
	$(MAKE) -C deploy images ARGS=$(ARGS)
