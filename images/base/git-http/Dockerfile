# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
#
# git-http — authenticated git over HTTP beside os-ui, so an engineer can
# `git clone https://<os>/git/<domain>.git`, fetch and push from VS Code (decision D27).
#
# Why our own image: the transport must be git's OWN `git-http-backend` CGI — we write no git
# protocol — and no stock git image ships a CGI-capable HTTP server. The pattern is the one
# `images/base/git-daemon` already proved: Alpine's distro packages, a separate process, non-root,
# and a build step that FAILS if the binary we depend on is absent (the git-daemon image exists
# because alpine/git silently omits `git-daemon` and the first rollout crash-looped on it).
#
# lighttpd + mod_cgi is the configuration git's own documentation names for http-backend. curl is
# here for the pre-receive / post-receive hooks: they call ONE OS endpoint
# (`/api/git/receive`) which holds the per-domain lock, validates and ingests (D28/D29).
#
# Licences — all three are separate processes from distro packages; nothing links to our code:
#   git      GPL-2.0        lighttpd  BSD-3-Clause        curl  curl (MIT-like)
# AUTHENTICATION lives in the OS, never here: the ingress authenticates every request against
# `/api/git/authenticate` (an OS personal access token) before it reaches this container, and the
# receive hooks re-resolve the same token server-side. This image is a transport, not a gate.
FROM alpine:3.21
RUN apk add --no-cache git lighttpd curl \
 && test -x /usr/libexec/git-core/git-http-backend \
 && test -x "$(git --exec-path)/git-http-backend" \
 && test -f /usr/lib/lighttpd/mod_cgi.so \
 && git --version \
 && lighttpd -v
COPY lighttpd.conf /etc/lighttpd/lighttpd.conf
# The pre-receive / post-receive hooks are NOT baked in: os-ui writes them into each bare repo
# (`core/infra/git-receive.ts` `ensureReceiveHooks`), because it is os-ui that creates the repos
# and os-ui that owns the contract they call. One copy of that script, in one language.
# A read-only root filesystem: lighttpd buffers request bodies (a push is a POST) under
# `server.upload-dirs`, which the chart mounts as an emptyDir at /tmp. Nothing else is written.
USER 65532:65532
EXPOSE 9419
ENTRYPOINT ["lighttpd", "-D", "-f", "/etc/lighttpd/lighttpd.conf"]
