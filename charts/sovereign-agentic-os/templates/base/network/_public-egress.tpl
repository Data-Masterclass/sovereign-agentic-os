{{- /*
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)

  "Public address space" for an egress ipBlock: 0.0.0.0/0 minus everything that is NOT the internet on the
  clusters we run on. Calico applies ipBlock to pod and Service-endpoint addresses too, so each range left out
  of `except` is a way into the cluster:
    - RFC1918 (10/8, 172.16/12, 192.168/16): private networks, kind/most CNIs' pod and service ranges;
    - 100.64.0.0/10: shared/CGNAT space — the pod and Service ranges on Gardener (STACKIT SKE: pods 100.64.x,
      Services 100.82.x, so ingress-nginx and every platform Service);
    - 169.254.0.0/16: link-local, incl. the cloud metadata endpoint;
    - 240.0.0.0/4: reserved — STACKIT SKE puts the Kubernetes API server endpoint there (240.83.x);
    - networkPolicies.apiserver.cidrs + extraCidrs: the API server wherever an operator named it.
  Used by every "public 443" rule: the egress proxy, the direct-HTTPS workloads, the software scanner.
  Usage:  except:
            {{- include "soa.network.nonPublicCidrs" . | nindent 14 }}
*/}}
{{- define "soa.network.nonPublicCidrs" -}}
{{- $api := ((.Values.networkPolicies | default dict).apiserver | default dict) -}}
{{- $all := list "10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16" "100.64.0.0/10" "169.254.0.0/16" "240.0.0.0/4" -}}
{{- $all = concat $all ($api.cidrs | default list) ($api.extraCidrs | default list) -}}
{{- $lines := list -}}
{{- range ($all | uniq) -}}{{- $lines = append $lines (printf "- %s" (. | quote)) -}}{{- end -}}
{{- join "\n" $lines -}}
{{- end -}}
