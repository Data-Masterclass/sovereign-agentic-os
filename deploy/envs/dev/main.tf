# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Dev environment: one SKE cluster with ONE platform node (plus a build pool that sits at ZERO
# nodes while no build runs), its reserved ingress IP and its own object-storage bucket +
# credential (6 resources). Everything is in the dev project (var.project_id).
#
# NO NETWORK RESOURCE, ON PURPOSE. In a project that is not part of a STACKIT Network Area, SKE
# creates the cluster's own network, subnet, security groups, router and public IP
# (docs.stackit.cloud/products/runtime/kubernetes-engine/basics/networking/). Production's
# project IS in an SNA, and projects in one SNA are connected to each other
# (docs.stackit.cloud/products/network/core-networking/network-area/faq/). So the dev project
# must NOT be added to the production SNA, and nothing here peers, routes or attaches to a
# production network. The only shared thing is the public internet.

locals {
  object_storage_endpoint = "https://object.storage.${var.region}.onstackit.cloud"
  # Every dev resource carries this label where the provider supports labels.
  labels = { environment = "dev", "managed-by" = "tofu-deploy-envs-dev" }
}

resource "stackit_ske_cluster" "dev" {
  project_id             = var.project_id
  name                   = var.cluster_name
  kubernetes_version_min = var.kubernetes_version_min

  node_pools = [
    {
      name               = "workers"
      machine_type       = var.node_machine_type
      minimum            = 1
      maximum            = 1
      availability_zones = [var.availability_zone]
      volume_size        = var.node_volume_size_gb
      volume_type        = var.node_volume_type
      os_name            = "flatcar"
      labels             = { "sovereign-os/environment" = "dev" }
      # The ONE pool that hosts SKE's system components (CoreDNS, metrics-server, ...). SKE needs at
      # least one such pool with maximum > 0; this is it. Explicit = the provider default, so writing
      # it changes nothing on the live cluster.
      allow_system_components = true
    },
    # App Builder BUILD pool (docs/components/app-builder-build.md "Dedicated build pool with
    # scale-to-zero"). Untrusted build code (an app's Dockerfile RUNs, in an unprivileged user
    # namespace) never shares a node kernel with the platform, so build pods run only here:
    #   - tainted soa.dev/build=true:NoSchedule: nothing without the toleration lands here (only the
    #     build-image pod tolerates it, plus node DaemonSets such as the CNI and SPO's spod);
    #   - labelled soa.dev/pool=builds: the build pod's nodeSelector (values.dev.yaml);
    #   - minimum 0: the cluster autoscaler adds the node only when a build pod is Pending and removes
    #     it once unneeded (SKE: 30 min unneeded; no scale-down within 1 h of a scale-up). Taints and
    #     labels are declared HERE, on the pool, so the autoscaler can simulate a node that does not
    #     exist yet (the scale-from-zero node template);
    #   - no system components, so nothing of SKE pins the node and it can go back to zero;
    #   - the same zone as `workers`: the pipeline's workspace is a zonal ReadWriteOnce volume that
    #     moves between the two pools;
    #   - the same OS as `workers`: flatcar, the latest SUPPORTED image unless
    #     var.build_pool_os_version_min pins it (Kubernetes is cluster-wide). Flatcar 4459+ ships
    #     containerd >= 2.0 and a kernel >= 6.3, which user namespaces with idmapped mounts need.
    {
      name                    = "builds"
      machine_type            = var.build_pool_machine_type
      minimum                 = 0
      maximum                 = var.build_pool_max
      max_surge               = 1
      max_unavailable         = 0
      availability_zones      = [var.availability_zone]
      volume_size             = var.build_pool_volume_size_gb
      volume_type             = var.node_volume_type
      os_name                 = "flatcar"
      os_version_min          = var.build_pool_os_version_min
      allow_system_components = false
      labels = {
        "sovereign-os/environment" = "dev"
        "soa.dev/pool"             = "builds"
      }
      taints = [
        { key = "soa.dev/build", value = "true", effect = "NoSchedule" }
      ]
    }
  ]

  # Same window and policy as production, so dev meets every SKE update first or together.
  maintenance = {
    enable_kubernetes_version_updates    = true
    enable_machine_image_version_updates = true
    start                                = "02:00:00Z"
    end                                  = "04:00:00Z"
  }
}

# Admin kubeconfig for the OPERATOR (scripts/dev/kubeconfig.sh writes it to a private file).
# CI never uses it: CI gets a namespace-less ServiceAccount kubeconfig of the dev cluster only
# (scripts/dev/ci-kubeconfig.sh), stored as the `dev` environment secret.
resource "stackit_ske_kubeconfig" "dev" {
  project_id   = var.project_id
  cluster_name = stackit_ske_cluster.dev.name
  refresh      = true
  expiration   = 604800 # 7 days; re-run the targeted apply (or the portal) to renew
}

# Reserved public IP for the dev ingress LoadBalancer (pinned with the Service annotation
# lb.stackit.cloud/external-address, as production does in deploy/terraform/publicip.tf). The
# Cloudflare record for dev.agentic.datamasterclass.com points straight at it.
resource "stackit_public_ip" "ingress" {
  project_id = var.project_id
  labels     = local.labels

  lifecycle {
    ignore_changes = [network_interface_id, labels]
  }
}

# --- DNS: NOT in Terraform, on purpose ----------------------------------------------------
# The public zone datamasterclass.com is served by Cloudflare (checked 2026-11-20: `dig NS
# datamasterclass.com` -> *.ns.cloudflare.com; agentic.datamasterclass.com is not delegated, and
# os.agentic.datamasterclass.com is a Cloudflare record pointing at production's reserved IP).
# The STACKIT zone in deploy/terraform/dns.tf is therefore not authoritative, and a dev zone here
# would answer nobody. Dev's name is ONE record the owner adds at Cloudflare (DNS only, not
# proxied): dev.agentic.datamasterclass.com  A  <tofu output ingress_public_ip>.

# --- Object storage: ONE bucket and ONE credential, both in the dev project ------------------
# The off-cluster target for dev backups and restore drills. The credential is project-scoped,
# and the project is dev's alone, so it cannot reach a production bucket.
resource "stackit_objectstorage_bucket" "dev" {
  project_id = var.project_id
  name       = "${var.name_prefix}-backups"
}

resource "stackit_objectstorage_credentials_group" "dev" {
  project_id = var.project_id
  name       = "${var.name_prefix}-app"
}

resource "stackit_objectstorage_credential" "dev" {
  project_id           = var.project_id
  credentials_group_id = stackit_objectstorage_credentials_group.dev.credentials_group_id
  expiration_timestamp = timeadd(timestamp(), "8760h")

  lifecycle {
    ignore_changes = [expiration_timestamp]
  }
}
