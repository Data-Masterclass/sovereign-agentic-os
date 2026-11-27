# Egress proxy — tinyproxy (GPL-2.0-or-later, unmodified Alpine package) on Alpine. A tiny, reliable
# allowlist forward proxy (the single sanctioned outbound chokepoint, security.md). Config +
# allowlist are mounted from a ConfigMap. Base pinned by digest.
FROM alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d

# The binary is MOVED off /usr/bin/tinyproxy (same bytes, unmodified) to a path no host AppArmor
# profile names. Ubuntu hosts can carry a `tinyproxy` profile that attaches by executable PATH; under
# kind the pod's processes run on the host kernel unconfined, so exec'ing /usr/bin/tinyproxy inside
# the container picked up the HOST profile, which denied every file read: the pod crash-looped with
# a misleading "Could not open config file". docs/ops/troubleshooting.md ("egress-proxy: Could not
# open config file").
RUN apk add --no-cache tinyproxy \
 && mkdir -p /opt/egress-proxy \
 && mv /usr/bin/tinyproxy /opt/egress-proxy/egress-proxy \
 && /opt/egress-proxy/egress-proxy -v

# tinyproxy runs in the foreground; config comes from the mounted ConfigMap.
USER nobody
ENTRYPOINT ["/opt/egress-proxy/egress-proxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
