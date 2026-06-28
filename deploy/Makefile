# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Sovereign Agentic OS — STACKIT deploy automation (two modes).
# One-command provision + GitOps deploy.
#
#   MODE=selfhosted (DEFAULT, Mode A) — SKE cluster + DNS only; every backend
#     bundled in-cluster (Postgres/OpenSearch/ClickHouse/Valkey/MinIO). Pauses
#     fully with the node pool — NO 24/7 managed-service billing.
#   MODE=managed    (Mode B)          — also provisions the STACKIT managed
#     services (PostgreSQL Flex / OpenSearch / Object Storage / Secrets Manager /
#     AI Model Serving). Managed services bill 24/7.
#
#   make stackit-up                 provision + deploy (Mode A, default)
#   make stackit-up MODE=managed    provision + deploy the full managed stack
#   make stackit-down               prune workloads + destroy infra
#   make sleep / wake               scale the SKE node pool to 0 / back
#   make sync                       kick an Argo CD sync
#   make images                     build + push the bespoke images (Mode B)
#
# DO NOT run stackit-up / images for real in the build phase — go-live only
# (needs the SA key, cost sign-off, and the armed cost guard). See deploy/README.md.

SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

# terraform or opentofu, whichever is on PATH.
TF        := $(shell command -v terraform || command -v tofu)
TF_DIR    := terraform
KUBECONFIG_FILE := $(abspath kubeconfig.yaml)
ARGOCD_NS := argocd

# ---- Mode selector (Mode A self-hosted = default) ---------------------------
# MODE=selfhosted -> enable_managed_backends=false (SKE+DNS only, bundled chart).
# MODE=managed    -> enable_managed_backends=true  (full managed stack, Mode B).
# TF_MODE_VARS is threaded into EVERY tofu apply (apply/sleep/wake/dns/destroy) so
# Mode A never re-creates managed services and Mode B keeps them.
MODE ?= selfhosted
ifeq ($(MODE),selfhosted)
  TF_MODE_VARS := -var enable_managed_backends=false
  GATE         := I-ACCEPT-MODE-A-COSTS
else ifeq ($(MODE),managed)
  TF_MODE_VARS :=
  GATE         := I-ACCEPT-MODE-B-COSTS
else
  $(error MODE must be 'selfhosted' or 'managed' (got '$(MODE)'))
endif

# Cost gate — stackit-up / stackit-down refuse to run without this.
CONFIRM   ?=

export KUBECONFIG = $(KUBECONFIG_FILE)
export MODE

.PHONY: help validate fmt plan apply kubeconfig argocd-install bootstrap \
        render secrets images sync stackit-up stackit-down sleep wake dns \
        _gate _need-tf

help: ## Show targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n",$$1,$$2}'

_need-tf:
	@[ -n "$(TF)" ] || { echo "terraform/opentofu not found on PATH"; exit 1; }

_gate:
	@[ "$(CONFIRM)" = "$(GATE)" ] || { \
	  echo "Refusing: this spends real money (MODE=$(MODE))."; \
	  if [ "$(MODE)" = "selfhosted" ]; then \
	    echo "  Mode A: SKE node pool + LB + DNS bill while running; pauses on 'make sleep'."; \
	  else \
	    echo "  Mode B: managed Postgres/OpenSearch/etc. bill 24/7 (even when nodes sleep)."; \
	  fi; \
	  echo "Re-run with: make $(MAKECMDGOALS) MODE=$(MODE) CONFIRM=$(GATE)"; \
	  echo "And confirm the cost guard is ARMED (stackit/cost-monitor.conf HARDSTOP_ARMED=true)."; \
	  exit 1; }

# ---- Local validation (safe; no STACKIT calls) ------------------------------

validate: _need-tf ## terraform init -backend=false + validate + fmt -check
	$(TF) -chdir=$(TF_DIR) init -backend=false -input=false
	$(TF) -chdir=$(TF_DIR) validate
	$(TF) -chdir=$(TF_DIR) fmt -check

fmt: _need-tf ## terraform fmt (write)
	$(TF) -chdir=$(TF_DIR) fmt

plan: _need-tf ## terraform plan (needs tfvars + SA key — first real read of STACKIT)
	$(TF) -chdir=$(TF_DIR) init -input=false
	$(TF) -chdir=$(TF_DIR) plan

# ---- Provision + bootstrap (go-live) ----------------------------------------

apply: _need-tf _gate ## terraform apply (⚠ first real spend)
	$(TF) -chdir=$(TF_DIR) init -input=false
	$(TF) -chdir=$(TF_DIR) apply -auto-approve $(TF_MODE_VARS)

kubeconfig: _need-tf ## Write ./kubeconfig.yaml from the terraform output (gitignored)
	@umask 077; $(TF) -chdir=$(TF_DIR) output -raw kubeconfig > $(KUBECONFIG_FILE)
	@echo "wrote $(KUBECONFIG_FILE)"; kubectl get nodes || true

argocd-install: ## Install Argo CD (pinned) into the cluster
	kubectl apply -k argocd/bootstrap
	kubectl -n $(ARGOCD_NS) rollout status deploy/argocd-server --timeout=300s

render: ## Fill the overlay + Argo manifests' REPLACE-… tokens (per MODE) from terraform outputs
	scripts/render-values.sh --mode $(MODE)

secrets: ## Push credential values into STACKIT Secrets Manager (dry-run; add --write)
	scripts/push-secrets.sh

bootstrap: argocd-install ## Apply the AppProject + app-of-apps (Argo reconciles the rest)
	kubectl apply -f argocd/project.yaml
	kubectl apply -f argocd/app-of-apps.yaml
	@echo "Argo CD is reconciling platform (waves 0–2) then the OS chart (wave 5)."

stackit-up: _gate ## Provision infra -> kubeconfig -> render -> Argo CD -> deploy from git
	$(MAKE) apply MODE=$(MODE) CONFIRM=$(GATE)
	$(MAKE) kubeconfig MODE=$(MODE)
	$(MAKE) render MODE=$(MODE)
	@[ "$(MODE)" = "managed" ] && echo ">> Push secrets now if not done: make secrets ARGS=--write" || \
	  echo ">> Mode A: backends are bundled — no Secrets Manager push needed."
	$(MAKE) bootstrap MODE=$(MODE)
	@echo "Done (MODE=$(MODE)). Watch: argocd app list  (or kubectl -n $(ARGOCD_NS) get applications)"

stackit-down: _gate ## Prune workloads (Argo) then destroy all infra
	-kubectl delete -f argocd/app-of-apps.yaml --wait=true || true
	-kubectl delete -f argocd/project.yaml || true
	$(TF) -chdir=$(TF_DIR) destroy -auto-approve $(TF_MODE_VARS)

# ---- Cost window — scale worker nodes to 0/back -----------------------------
# Mode A: scaling to 0 pauses the WHOLE stack (everything is in-cluster) — only
#   the LB + DNS keep a small charge. Mode B: managed services still bill 24/7.
# TF_MODE_VARS keeps the managed-service toggle stable so sleep/wake never flip it.

sleep: _need-tf ## Scale the SKE node pool to 0 (overnight). Mode A pauses everything; Mode B keeps managed services billing.
	$(TF) -chdir=$(TF_DIR) apply -auto-approve $(TF_MODE_VARS) \
	  -var node_pool_min=0 -var node_pool_max=0
	@[ "$(MODE)" = "managed" ] && \
	  echo "Node pool scaled to 0. Managed Postgres/OpenSearch/registry still bill." || \
	  echo "Node pool scaled to 0. Mode A: whole stack paused (only LB + DNS remain)."

wake: _need-tf ## Scale the SKE node pool back to its configured size
	$(TF) -chdir=$(TF_DIR) apply -auto-approve $(TF_MODE_VARS)
	@echo "Node pool restored from terraform.tfvars (default 3)."

# ---- Day-2 ------------------------------------------------------------------

sync: ## Trigger an Argo CD sync of the root app (or commit+push to auto-sync)
	argocd app sync sovereign-os-root || \
	  kubectl -n $(ARGOCD_NS) patch app sovereign-os-root --type merge \
	    -p '{"operation":{"sync":{}}}'

dns: _need-tf ## Re-apply DNS records with the real ingress LB IP (after ingress is up)
	@IP=$$(kubectl -n ingress-nginx get svc ingress-nginx-controller \
	  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'); \
	  echo "ingress LB IP: $$IP"; \
	  $(TF) -chdir=$(TF_DIR) apply -auto-approve $(TF_MODE_VARS) -var ingress_lb_ip=$$IP

images: ## Build + push the bespoke images to the registry by digest (dry-run; add --push)
	scripts/publish-images.sh $(ARGS)
