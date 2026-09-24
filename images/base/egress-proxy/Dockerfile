# Egress proxy — tinyproxy (GPL) on Alpine. A tiny, reliable allowlist forward
# proxy (the single sanctioned outbound chokepoint, security.md). Config +
# allowlist are mounted from a ConfigMap. Base pinned by digest.
FROM alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d

RUN apk add --no-cache tinyproxy

# tinyproxy runs in the foreground; config comes from the mounted ConfigMap.
USER nobody
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
