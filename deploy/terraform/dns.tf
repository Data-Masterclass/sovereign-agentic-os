# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# STACKIT DNS — the zone for the deployment + per-subdomain records pointing at
# the ingress load balancer. The LB public IP is only known AFTER ingress-nginx
# is up (Argo CD platform wave), so the record sets are created with a
# placeholder and reconciled at go-live (Makefile `dns` target patches them with
# the real Service LoadBalancer IP). Apex + subdomains per ingress_subdomains.

resource "stackit_dns_zone" "this" {
  project_id    = var.project_id
  name          = var.name_prefix
  dns_name      = var.dns_name
  contact_email = var.dns_contact_email
  type          = "primary"
}

# Subdomain A records. `var.ingress_lb_ip` is empty until the ingress LB exists;
# the Makefile `dns` target re-applies with the real IP (-var ingress_lb_ip=...).
variable "ingress_lb_ip" {
  description = "Public IPv4 of the ingress load balancer. Empty during initial apply; filled by `make dns` once ingress-nginx has its LB IP."
  type        = string
  default     = "192.0.2.1" # TEST-NET-1 placeholder; replaced at go-live.
}

resource "stackit_dns_record_set" "subdomains" {
  for_each   = toset(var.ingress_subdomains)
  project_id = var.project_id
  zone_id    = stackit_dns_zone.this.zone_id
  name       = each.key
  type       = "A"
  records    = [var.ingress_lb_ip]
  ttl        = 300
}
