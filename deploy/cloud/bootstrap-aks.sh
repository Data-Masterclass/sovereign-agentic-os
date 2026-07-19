#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# bootstrap-aks.sh — irreducible AKS prerequisites for the OS chart (keyless).
# =============================================================================
# Mirrors docs/research/cloud-install-gke-eks-aks.md §2 (AKS) and the style of
# scripts/bootstrap-local.sh. Provisions: OIDC issuer + Entra Workload ID on the
# cluster, a user-assigned Managed Identity (MI), federated credentials (FIC) for
# each KSA, an ADLS Gen2 account (HNS ON) + Storage Blob Data role, and an Azure
# OpenAI resource with three deployments + the Cognitive Services User role.
#
# Keyless: Entra Workload ID federates a KSA's OIDC subject to a user-assigned MI;
# pods get tokens via DefaultAzureCredential. No client secrets.
# FOOTGUN (report §2): AAD Pod Identity is DEPRECATED — this uses Workload ID.
# The pod label azure.workload.identity/use:"true" is MANDATORY (fail-close);
# the chart/overlay must set it.
#
# Idempotent: every step checks-before-create; safe to re-run.
#
# Usage:
#   SOS_SUBSCRIPTION=<sub-id> SOS_REGION=eastus SOS_BUCKET=sovereignosdata \
#     ./deploy/cloud/bootstrap-aks.sh
#
# Optional overrides:
#   SOS_RESOURCE_GROUP (default: agentic-os)   resource group
#   SOS_CLUSTER        (default: agentic-os)   AKS cluster name
#   SOS_NAMESPACE      (default: agentic-os)   K8s namespace the KSAs live in
#   SOS_AOAI           (default: sovereign-os-openai)  Azure OpenAI resource name
#   SOS_LLM_REASONING / SOS_LLM_DEFAULT / SOS_LLM_EMBED  -> the 3 AOAI deployments
#
# NOTE: ADLS/Storage account names are 3–24 lowercase-alnum (NO hyphens). If
# SOS_BUCKET contains hyphens they are stripped for the account name.
# =============================================================================
set -euo pipefail

# --- inputs ----------------------------------------------------------------
SUBSCRIPTION="${SOS_SUBSCRIPTION:-}"
REGION="${SOS_REGION:-eastus}"
BUCKET="${SOS_BUCKET:-}"
RG="${SOS_RESOURCE_GROUP:-agentic-os}"
CLUSTER="${SOS_CLUSTER:-agentic-os}"
NAMESPACE="${SOS_NAMESPACE:-agentic-os}"
AOAI="${SOS_AOAI:-sovereign-os-openai}"
MI_NAME="sovereign-os-identity"

KSA_TRINO="trino-sa"
KSA_LITELLM="litellm-sa"
KSA_CNPG="cnpg-sa"

step() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
command -v az >/dev/null 2>&1 || die "az not found — install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli"
[ -n "$BUCKET" ] || die "SOS_BUCKET is required (used for the ADLS Gen2 container name)"
[ -n "$SUBSCRIPTION" ] || SUBSCRIPTION="$(az account show --query id -o tsv 2>/dev/null)" || die "SOS_SUBSCRIPTION is required and could not be derived — run 'az login'"
az account set --subscription "$SUBSCRIPTION" >/dev/null || die "cannot select subscription $SUBSCRIPTION"

# Storage account name: 3–24 lowercase alnum, no hyphens.
SA_NAME="$(printf '%s' "$BUCKET" | tr -cd 'a-z0-9' | cut -c1-24)"
[ -n "$SA_NAME" ] || die "could not derive a valid storage account name from SOS_BUCKET=$BUCKET"

step "AKS bootstrap for subscription=$SUBSCRIPTION region=$REGION storage=$SA_NAME"

# --- 1. resource group ------------------------------------------------------
step "Ensuring resource group '$RG'"
if az group show --name "$RG" >/dev/null 2>&1; then
  ok "resource group $RG already exists"
else
  az group create --name "$RG" --location "$REGION" >/dev/null
  ok "created resource group $RG"
fi

# --- 2. OIDC issuer + Entra Workload ID on the cluster ----------------------
step "Ensuring OIDC issuer + Workload Identity on cluster '$CLUSTER'"
if az aks show --resource-group "$RG" --name "$CLUSTER" >/dev/null 2>&1; then
  ISSUER="$(az aks show --resource-group "$RG" --name "$CLUSTER" --query 'oidcIssuerProfile.issuerUrl' -o tsv 2>/dev/null || true)"
  if [ -z "$ISSUER" ] || [ "$ISSUER" = "None" ]; then
    az aks update --resource-group "$RG" --name "$CLUSTER" \
      --enable-oidc-issuer --enable-workload-identity >/dev/null
    ISSUER="$(az aks show --resource-group "$RG" --name "$CLUSTER" --query 'oidcIssuerProfile.issuerUrl' -o tsv)"
    ok "enabled OIDC + Workload Identity"
  else
    ok "OIDC issuer already present"
  fi
else
  warn "cluster $CLUSTER not found in RG $RG — create it with --enable-oidc-issuer --enable-workload-identity, then re-run."
  ISSUER=""
fi

# --- 3. user-assigned Managed Identity -------------------------------------
step "Ensuring user-assigned Managed Identity '$MI_NAME'"
if az identity show --resource-group "$RG" --name "$MI_NAME" >/dev/null 2>&1; then
  ok "MI $MI_NAME already exists"
else
  az identity create --resource-group "$RG" --name "$MI_NAME" --location "$REGION" >/dev/null
  ok "created MI $MI_NAME"
fi
MI_CLIENT_ID="$(az identity show --resource-group "$RG" --name "$MI_NAME" --query clientId -o tsv)"
MI_PRINCIPAL_ID="$(az identity show --resource-group "$RG" --name "$MI_NAME" --query principalId -o tsv)"

# --- 4. federated credentials (one FIC per KSA; limit is 20) ---------------
# FOOTGUN (report §2): a Managed Identity allows <=20 federated credentials. We
# create one per KSA (3) — plenty of headroom.
add_fic() {
  local ksa="$1"
  local fic="fic-$ksa"
  [ -n "$ISSUER" ] || { warn "no OIDC issuer — skipping FIC for $ksa"; return; }
  if az identity federated-credential show --identity-name "$MI_NAME" --resource-group "$RG" --name "$fic" >/dev/null 2>&1; then
    ok "federated credential for $ksa already exists"
  else
    az identity federated-credential create --identity-name "$MI_NAME" --resource-group "$RG" \
      --name "$fic" --issuer "$ISSUER" \
      --subject "system:serviceaccount:$NAMESPACE:$ksa" \
      --audience "api://AzureADTokenExchange" >/dev/null
    ok "federated credential for $ksa"
  fi
}

step "Creating federated credentials (ns=$NAMESPACE, <=20 per MI)"
add_fic "$KSA_TRINO"
add_fic "$KSA_LITELLM"
add_fic "$KSA_CNPG"

# --- 5. ADLS Gen2 (HNS ON) + role -------------------------------------------
step "Ensuring ADLS Gen2 storage account '$SA_NAME' (hierarchical namespace ON)"
if az storage account show --name "$SA_NAME" --resource-group "$RG" >/dev/null 2>&1; then
  ok "storage account $SA_NAME already exists"
else
  # HNS on = ADLS Gen2 (report §2: required for the Trino native Azure FS path).
  az storage account create --name "$SA_NAME" --resource-group "$RG" --location "$REGION" \
    --sku Standard_LRS --kind StorageV2 --hierarchical-namespace true >/dev/null
  ok "created ADLS Gen2 account $SA_NAME"
fi
SA_ID="$(az storage account show --name "$SA_NAME" --resource-group "$RG" --query id -o tsv)"

step "Granting the MI 'Storage Blob Data Contributor' on $SA_NAME"
if az role assignment list --assignee "$MI_PRINCIPAL_ID" --scope "$SA_ID" --role "Storage Blob Data Contributor" --query '[0].id' -o tsv 2>/dev/null | grep -q .; then
  ok "role already assigned"
else
  az role assignment create --assignee-object-id "$MI_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
    --role "Storage Blob Data Contributor" --scope "$SA_ID" >/dev/null
  ok "assigned Storage Blob Data Contributor"
fi

# --- 6. Azure OpenAI resource + 3 deployments + Cognitive Services User -----
step "Ensuring Azure OpenAI resource '$AOAI'"
if az cognitiveservices account show --name "$AOAI" --resource-group "$RG" >/dev/null 2>&1; then
  ok "Azure OpenAI resource $AOAI already exists"
else
  az cognitiveservices account create --name "$AOAI" --resource-group "$RG" --location "$REGION" \
    --kind OpenAI --sku S0 --custom-domain "$AOAI" >/dev/null \
    || die "failed to create Azure OpenAI resource (your subscription may need to be allow-listed for Azure OpenAI)"
  ok "created Azure OpenAI resource $AOAI"
fi
AOAI_ID="$(az cognitiveservices account show --name "$AOAI" --resource-group "$RG" --query id -o tsv)"

deploy_model() {
  local dep="$1" model="$2"
  [ -n "$model" ] || return 0
  if az cognitiveservices account deployment show --name "$AOAI" --resource-group "$RG" --deployment-name "$dep" >/dev/null 2>&1; then
    ok "deployment $dep already exists"
  else
    az cognitiveservices account deployment create --name "$AOAI" --resource-group "$RG" \
      --deployment-name "$dep" --model-name "$model" --model-format OpenAI \
      --sku-capacity 10 --sku-name Standard >/dev/null \
      || warn "could not create deployment $dep ($model) — model may be unavailable in $REGION; create it in the AOAI Studio."
    ok "deployment $dep -> $model"
  fi
}

step "Creating the three tier deployments"
deploy_model "sovereign-reasoning" "${SOS_LLM_REASONING:-gpt-5.4}"
deploy_model "sovereign-default"   "${SOS_LLM_DEFAULT:-gpt-5.4-mini}"
deploy_model "sovereign-embed"     "${SOS_LLM_EMBED:-text-embedding-3-large}"

step "Granting the MI 'Cognitive Services User' on $AOAI"
if az role assignment list --assignee "$MI_PRINCIPAL_ID" --scope "$AOAI_ID" --role "Cognitive Services User" --query '[0].id' -o tsv 2>/dev/null | grep -q .; then
  ok "role already assigned"
else
  az role assignment create --assignee-object-id "$MI_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
    --role "Cognitive Services User" --scope "$AOAI_ID" >/dev/null
  ok "assigned Cognitive Services User"
fi

# --- 7. summary -------------------------------------------------------------
step "AKS bootstrap complete."
cat <<EOF

  Pass these to \`sos install\`:
    --cloud aks --subscription $SUBSCRIPTION --region $REGION --bucket $SA_NAME

  Keyless identity (annotate KSAs in ns $NAMESPACE with the MI client id):
    azure.workload.identity/client-id: $MI_CLIENT_ID
  AND set the MANDATORY pod label (fail-close): azure.workload.identity/use: "true"
  KSAs federated: $KSA_TRINO, $KSA_LITELLM, $KSA_CNPG. No client secrets are stored.

  FOOTGUNS (report §2): AAD Pod Identity is deprecated — this uses Entra Workload
  ID; the pod label above is mandatory; ADLS needs HNS ON (done); an AOAI model
  that is not available in $REGION must be deployed in the Studio.

  Next:  helm upgrade --install agentic-os charts/sovereign-agentic-os \\
           -n $NAMESPACE --create-namespace -f values.aks.yaml -f install.yaml
EOF
