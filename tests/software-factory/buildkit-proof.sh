#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# FEATURE: App Builder build platform (workstream C1, step 1) - the stop-and-report proof.
# USER STORY: As the platform owner I want proof, on kind AND on the real cluster, that our own builder image builds
#   an app image with no privilege and no registry credential, and that only a separate push pod holds the
#   per-domain credential, before anything else of the build platform is built on top of it.
# ARCHITECTURE: one throwaway namespace (Pod Security `baseline` enforced, `restricted` warned) holding exactly the
#   shape the pipeline uses (spec 6.1/6.2), so the proof is the design and not a lab variant:
#     - Zot (upstream image, ClusterIP, htpasswd auth, on-demand mirror of the allowlisted base image), its config and
#       htpasswd rendered by OUR `zot-users` binary (images/base/builder) from a per-domain push Secret written the
#       way os-ui writes it (label soa.dev/zot-push=true, annotation soa.dev/zot-repository=apps/<domain>);
#     - the BUILD pod: `hostUsers: false`, seccomp RuntimeDefault (or the approved Localhost fallback), no AppArmor
#       field (unset = the runtime default where the node has AppArmor; kubelet refuses `RuntimeDefault` on a node
#       without it), not privileged, no capability added, no Secret, no ServiceAccount token. buildkitd runs in a
#       native sidecar under rootlesskit (pod network, native snapshotter); buildctl writes an OCI image layout to
#       the shared workspace;
#     - the PUSH pod: restricted-compliant, `crane push` with the domain's push credential, digest on its
#       termination message;
#     - checks: digest is in Zot, the pull identity reads it, the push identity of domain A cannot write domain B,
#       anonymous cannot push, the build pod spec holds no Secret/token.
#   Prints a short evidence report (versions, kernel, seccomp mode, digest). Leaves nothing behind unless KEEP=1.
#
# Usage (never touches the current context; the kubeconfig is always explicit):
#   PROOF_KUBECONFIG=<file> BUILDER_IMAGE=<ref> [SECCOMP=runtime-default|localhost] [LOCALHOST_PROFILE=operator/<ns>/<name>.json]
#     [IMAGE_PULL_SECRET=<name of a dockerconfigjson Secret to copy from PULL_SECRET_FROM_NS>] bash tests/software-factory/buildkit-proof.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
: "${PROOF_KUBECONFIG:?set PROOF_KUBECONFIG}"
: "${BUILDER_IMAGE:?set BUILDER_IMAGE (e.g. sovereign-os/builder:proof on kind, a ghcr digest elsewhere)}"
SECCOMP="${SECCOMP:-runtime-default}"
NS="${PROOF_NS:-c1-buildkit-proof}"
ZOT_IMAGE="${ZOT_IMAGE:-ghcr.io/project-zot/zot:v2.1.23@sha256:9d3de83ac2099e6f4843045b4c9b65b7e8baf40f92d28f54906dee9d4d390fd7}"
CONTEXT_IMAGE="${CONTEXT_IMAGE:-alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf}"
BUILD_TIMEOUT="${BUILD_TIMEOUT:-1500s}"
DOMAIN="${PROOF_DOMAIN:-proof}"
SLUG="${PROOF_SLUG:-proof-app}"
k() { kubectl --kubeconfig "$PROOF_KUBECONFIG" "$@"; }
kn() { k -n "$NS" "$@"; }
say() { printf '\n==> %s\n' "$*"; }
work="$(mktemp -d)"
cleanup() {
  rc=$?
  if [ "$rc" != 0 ]; then
    echo "--- diagnostics (exit $rc)" >&2
    kn get pods -o wide >&2 || true
    kn get events --sort-by=.lastTimestamp 2>/dev/null | tail -25 >&2 || true
    for p in build push; do kn logs "$p" --all-containers --tail=60 >&2 2>/dev/null || true; done
    kn logs deploy/zot --tail=30 >&2 2>/dev/null || true
  fi
  rm -rf "$work"
  if [ "${KEEP:-}" != "1" ]; then k delete namespace "$NS" --wait=false >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

case "$SECCOMP" in
  runtime-default) seccomp_yaml='{ type: RuntimeDefault }' ;;
  localhost) : "${LOCALHOST_PROFILE:?SECCOMP=localhost needs LOCALHOST_PROFILE (the kubelet-relative path SPO reports)}"
             seccomp_yaml="{ type: Localhost, localhostProfile: ${LOCALHOST_PROFILE} }" ;;
  *) echo "SECCOMP must be runtime-default or localhost (never Unconfined)" >&2; exit 2 ;;
esac

say "0. cluster facts"
server="$(k version -o json | sed -n 's/.*"gitVersion": *"\(v[^"]*\)".*/\1/p' | tail -1)"
node="$(k get nodes -o jsonpath='{range .items[*]}{.metadata.name} kernel={.status.nodeInfo.kernelVersion} runtime={.status.nodeInfo.containerRuntimeVersion} os={.status.nodeInfo.osImage}{"\n"}{end}')"
echo "server $server"; echo "$node"

say "1. the sample app (nextjs-web@2 golden-path tree, as an app is created)"
mkdir -p "$work/app"
cat > "$work/materialize.ts" <<TS
import { goldenPathFiles } from '$root/os-ui/tabs/software/lib/golden-path.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
for (const f of goldenPathFiles('nextjs-web', { name: 'Proof App', slug: '$SLUG' }, 2)) {
  const p = join(process.argv[2], f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content);
}
TS
(cd "$root/os-ui" && node --no-warnings --experimental-strip-types --import ./scripts/test-setup.mjs "$work/materialize.ts" "$work/app")
tar -C "$work/app" -czf "$work/app.tgz" .
echo "context: $(find "$work/app" -type f | wc -l | tr -d ' ') files, $(wc -c < "$work/app.tgz" | tr -d ' ') bytes compressed"

say "2. namespace (Pod Security baseline enforced, restricted warned)"
k delete namespace "$NS" --ignore-not-found --wait=true >/dev/null
k create namespace "$NS" >/dev/null
k label namespace "$NS" pod-security.kubernetes.io/enforce=baseline pod-security.kubernetes.io/enforce-version=latest \
  pod-security.kubernetes.io/warn=restricted >/dev/null
kn create configmap app-context --from-file=app.tgz="$work/app.tgz" >/dev/null
if [ -n "${IMAGE_PULL_SECRET:-}" ]; then
  k -n "${PULL_SECRET_FROM_NS:?}" get secret "$IMAGE_PULL_SECRET" -o json \
    | sed -e "s/\"namespace\": *\"[^\"]*\"/\"namespace\": \"$NS\"/" -e '/"resourceVersion"/d;/"uid"/d;/"creationTimestamp"/d' \
    | k apply -f - >/dev/null
  pull_secrets="imagePullSecrets: [{ name: ${IMAGE_PULL_SECRET} }]"
else
  pull_secrets=""
fi

say "3. the domain's push credential, written the way os-ui writes it"
pw="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
zot="zot.${NS}.svc.cluster.local:5000"
dcj="$(printf '{"auths":{"%s":{"auth":"%s"}}}' "$zot" "$(printf 'push-%s:%s' "$DOMAIN" "$pw" | base64 | tr -d '\n')")"
kn create secret generic "zot-push-$DOMAIN" --from-literal=username="push-$DOMAIN" --from-literal=password="$pw" \
  --from-literal=.dockerconfigjson="$dcj" >/dev/null
kn label secret "zot-push-$DOMAIN" soa.dev/zot-push=true >/dev/null
kn annotate secret "zot-push-$DOMAIN" soa.dev/zot-repository="apps/$DOMAIN" >/dev/null

say "4. Zot config template + zot-users (our binary renders htpasswd and access control)"
cat <<YAML | kn apply -f - >/dev/null
apiVersion: v1
kind: ConfigMap
metadata: { name: zot-config-template }
data:
  config.json: |
    {
      "distSpecVersion": "1.1.1",
      "storage": { "rootDirectory": "/var/lib/registry", "gc": true, "dedupe": false },
      "http": { "address": "0.0.0.0", "port": "5000",
        "accessControl": { "repositories": { "library/**": { "anonymousPolicy": ["read"] } } } },
      "log": { "level": "info" },
      "extensions": { "sync": { "enable": true, "registries": [ { "urls": ["https://registry-1.docker.io"], "onDemand": true,
        "tlsVerify": true, "maxRetries": 3, "retryDelay": "10s", "content": [ { "prefix": "library/node" } ] } ] } }
    }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: zot-users }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: zot-users }
rules:
  - { apiGroups: [""], resources: ["secrets"], verbs: ["get", "list", "create", "update"] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: zot-users }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: zot-users }
subjects: [{ kind: ServiceAccount, name: zot-users }]
---
apiVersion: batch/v1
kind: Job
metadata: { name: zot-users }
spec:
  backoffLimit: 0
  template:
    spec:
      serviceAccountName: zot-users
      restartPolicy: Never
      ${pull_secrets}
      securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: zot-users
          image: ${BUILDER_IMAGE}
          imagePullPolicy: IfNotPresent
          command: ["/usr/local/bin/zot-users"]
          env:
            - { name: PUSH_NAMESPACE, value: "${NS}" }
            - { name: ZOT_NAMESPACE, value: "${NS}" }
            - { name: PULL_NAMESPACES, value: "${NS}" }
            - { name: REGISTRY_PULL_HOST, value: "${zot}" }
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
          resources: { requests: { cpu: 10m, memory: 32Mi }, limits: { cpu: 500m, memory: 128Mi } }
          volumeMounts: [{ name: template, mountPath: /etc/zot-template, readOnly: true }]
      volumes: [{ name: template, configMap: { name: zot-config-template } }]
YAML
kn wait --for=condition=complete job/zot-users --timeout=180s >/dev/null
kn logs job/zot-users

say "5. Zot (ClusterIP only)"
cat <<YAML | kn apply -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: { name: zot }
spec:
  replicas: 1
  selector: { matchLabels: { app: zot } }
  template:
    metadata: { labels: { app: zot } }
    spec:
      automountServiceAccountToken: false
      securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: zot
          image: ${ZOT_IMAGE}
          args: ["serve", "/etc/zot/config.json"]
          ports: [{ name: registry, containerPort: 5000 }]
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
          resources: { requests: { cpu: 20m, memory: 128Mi }, limits: { cpu: "1", memory: 512Mi } }
          readinessProbe: { tcpSocket: { port: registry }, periodSeconds: 3 }
          volumeMounts:
            - { name: auth, mountPath: /etc/zot, readOnly: true }
            - { name: data, mountPath: /var/lib/registry }
            - { name: tmp, mountPath: /tmp }
      volumes:
        - { name: auth, secret: { secretName: zot-auth } }
        - { name: data, emptyDir: {} }
        - { name: tmp, emptyDir: {} }
---
apiVersion: v1
kind: Service
metadata: { name: zot }
spec:
  type: ClusterIP
  selector: { app: zot }
  ports: [{ name: registry, port: 5000, targetPort: registry }]
YAML
kn rollout status deploy/zot --timeout=180s

say "6. BUILD pod: hostUsers=false, seccomp ${SECCOMP}, no privilege, no Secret, no token"
cat <<YAML | kn apply -f - >/dev/null
apiVersion: v1
kind: ConfigMap
metadata: { name: buildkitd }
data:
  buildkitd.toml: |
    [worker.oci]
      enabled = true
      snapshotter = "native"
      gc = true
    [worker.containerd]
      enabled = false
    # Base images come only through the platform registry's mirror (spec 6.1).
    [registry."docker.io"]
      mirrors = ["${zot}"]
    [registry."${zot}"]
      http = true
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: workspace }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 2Gi } }
---
apiVersion: v1
kind: Pod
metadata: { name: build, labels: { role: build } }
spec:
  hostUsers: false
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  ${pull_secrets}
  securityContext:
    seccompProfile: ${seccomp_yaml}
  initContainers:
    - name: context
      image: ${CONTEXT_IMAGE}
      command: ["sh", "-c", "rm -rf /workspace/app /workspace/out && mkdir -p /workspace/app /workspace/out && tar -xzf /context/app.tgz -C /workspace/app && chmod -R a+rwX /workspace"]
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL], add: [CHOWN, FOWNER, DAC_OVERRIDE] } }
      resources: { requests: { cpu: 10m, memory: 16Mi }, limits: { cpu: 200m, memory: 64Mi } }
      volumeMounts:
        - { name: context, mountPath: /context, readOnly: true }
        - { name: workspace, mountPath: /workspace }
    - name: buildkitd
      image: ${BUILDER_IMAGE}
      imagePullPolicy: IfNotPresent
      restartPolicy: Always
      command: ["/usr/local/bin/rootlesskit"]
      args: ["--net=host", "--state-dir=/run/rootlesskit",
             "/usr/local/bin/buildkitd", "--config=/etc/buildkit/buildkitd.toml", "--addr=unix:///run/buildkit/buildkitd.sock",
             "--root=/var/lib/buildkit", "--oci-worker-net=host", "--oci-worker-no-process-sandbox"]
      # no_new_privs must be OFF here (Pod Security baseline allows it): rootlesskit re-execs its child inside the new
      # user namespace to hold capabilities THERE, and no_new_privs strips capabilities gained at execve (the proof saw
      # "Capabilities: {Effective:0}" and a hang). The image holds no setuid/setcap binary, so nothing else can gain.
      securityContext: { allowPrivilegeEscalation: true }
      # A native sidecar's startupProbe gates the main container (a readinessProbe does not).
      startupProbe:
        exec: { command: ["/usr/local/bin/buildctl", "--addr=unix:///run/buildkit/buildkitd.sock", "debug", "workers"] }
        periodSeconds: 2
        failureThreshold: 60
      resources: { requests: { cpu: 250m, memory: 1Gi }, limits: { cpu: "2", memory: 3Gi } }
      volumeMounts:
        - { name: config, mountPath: /etc/buildkit, readOnly: true }
        - { name: run, mountPath: /run }
        - { name: state, mountPath: /var/lib/buildkit }
        - { name: tmp, mountPath: /tmp }
  containers:
    - name: build
      image: ${BUILDER_IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/usr/local/bin/buildctl"]
      args: ["--addr=unix:///run/buildkit/buildkitd.sock", "build", "--progress=plain", "--frontend=dockerfile.v0",
             "--local=context=/workspace/app", "--local=dockerfile=/workspace/app",
             "--output=type=oci,dest=/workspace/out/oci,tar=false"]
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
      resources: { requests: { cpu: 10m, memory: 32Mi }, limits: { cpu: 500m, memory: 256Mi } }
      volumeMounts:
        - { name: run, mountPath: /run }
        - { name: workspace, mountPath: /workspace }
  volumes:
    - { name: context, configMap: { name: app-context } }
    - { name: config, configMap: { name: buildkitd } }
    - { name: workspace, persistentVolumeClaim: { claimName: workspace } }
    - { name: run, emptyDir: {} }
    - { name: state, emptyDir: {} }
    - { name: tmp, emptyDir: {} }
YAML
spec="$(kn get pod build -o json)"
if printf '%s' "$spec" | grep -Eq '"secret"|"projected"|"privileged": *true|"Unconfined"|SYS_ADMIN'; then
  echo "FAIL: the build pod spec holds a Secret/projected token, privilege or Unconfined" >&2; exit 1
fi
echo "build pod spec: no Secret volume, no projected token, not privileged, no Unconfined, no added capability"
# Poll rather than wait: a buildkitd that cannot start (e.g. the seccomp profile refuses its namespaces) restarts in
# a loop and the pod never finishes, so three restarts end the proof with buildkitd's own error.
deadline=$(( $(date +%s) + ${BUILD_TIMEOUT%s} )); phase=""
while :; do
  phase="$(kn get pod build -o jsonpath='{.status.phase}')"
  restarts="$(kn get pod build -o jsonpath='{.status.initContainerStatuses[?(@.name=="buildkitd")].restartCount}')"
  if [ "$phase" = Succeeded ] || [ "$phase" = Failed ]; then break; fi
  if [ "${restarts:-0}" -ge 3 ]; then phase="buildkitd-crashloop"; break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then phase="timeout($phase)"; break; fi
  sleep 5
done
if [ "$phase" != Succeeded ]; then
  echo "BUILD DID NOT SUCCEED ($phase) with seccomp $SECCOMP" >&2
  kn logs build -c buildkitd --previous --tail=40 >&2 2>/dev/null || true
  kn logs build -c buildkitd --tail=40 >&2 || true
  kn logs build -c build --tail=40 >&2 || true
  exit 3
fi
kn logs build -c build | tail -6

say "7. PUSH pod: the only pod with the domain's push credential (restricted-compliant)"
cat <<YAML | kn apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata: { name: push, labels: { role: push } }
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  ${pull_secrets}
  securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: push
      image: ${BUILDER_IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/usr/local/bin/crane"]
      args: ["push", "--insecure", "--image-refs=/dev/termination-log", "/workspace/out/oci", "${zot}/apps/${DOMAIN}/${SLUG}:proof"]
      env: [{ name: DOCKER_CONFIG, value: /docker }]
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
      resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { cpu: 500m, memory: 256Mi } }
      volumeMounts:
        - { name: workspace, mountPath: /workspace, readOnly: true }
        - { name: push, mountPath: /docker, readOnly: true }
  volumes:
    - { name: workspace, persistentVolumeClaim: { claimName: workspace, readOnly: true } }
    - name: push
      secret: { secretName: zot-push-${DOMAIN}, items: [{ key: .dockerconfigjson, path: config.json }] }
YAML
kn wait --for=jsonpath='{.status.phase}'=Succeeded pod/push --timeout=300s
ref="$(kn get pod push -o jsonpath='{.status.containerStatuses[0].state.terminated.message}')"
digest="${ref##*@}"
echo "pushed: $ref"
case "$digest" in sha256:*) ;; *) echo "FAIL: no digest from crane" >&2; exit 1 ;; esac

say "8. checks from inside the cluster: pull identity reads the digest; push-$DOMAIN cannot write another domain; anonymous cannot push"
cat <<YAML | kn apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata: { name: verify }
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  ${pull_secrets}
  securityContext: { runAsNonRoot: true, runAsUser: 65532, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: pull-reads
      image: ${BUILDER_IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/usr/local/bin/crane", "digest", "--insecure", "${zot}/apps/${DOMAIN}/${SLUG}@${digest}"]
      env: [{ name: DOCKER_CONFIG, value: /pull }]
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
      volumeMounts: [{ name: pull, mountPath: /pull, readOnly: true }]
    - name: push-other-domain
      image: ${BUILDER_IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/usr/local/bin/crane", "copy", "--insecure", "${zot}/apps/${DOMAIN}/${SLUG}@${digest}", "${zot}/apps/other-domain/${SLUG}:stolen"]
      env: [{ name: DOCKER_CONFIG, value: /push }]
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
      volumeMounts: [{ name: push, mountPath: /push, readOnly: true }]
    - name: anonymous-push
      image: ${BUILDER_IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/usr/local/bin/crane", "push", "--insecure", "/workspace/out/oci", "${zot}/apps/${DOMAIN}/${SLUG}:anon"]
      env: [{ name: DOCKER_CONFIG, value: /nowhere }]
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
      volumeMounts: [{ name: workspace, mountPath: /workspace, readOnly: true }]
  volumes:
    - name: pull
      secret: { secretName: app-registry-pull, items: [{ key: .dockerconfigjson, path: config.json }] }
    - name: push
      secret: { secretName: zot-push-${DOMAIN}, items: [{ key: .dockerconfigjson, path: config.json }] }
    - { name: workspace, persistentVolumeClaim: { claimName: workspace, readOnly: true } }
YAML
for _ in $(seq 1 60); do
  n="$(kn get pod verify -o jsonpath='{range .status.containerStatuses[*]}{.state.terminated.exitCode}{" "}{end}' | wc -w | tr -d ' ')"
  [ "$n" = 3 ] && break; sleep 3
done
code() { kn get pod verify -o jsonpath="{.status.containerStatuses[?(@.name=='$1')].state.terminated.exitCode}"; }
pr="$(code pull-reads)"; po="$(code push-other-domain)"; an="$(code anonymous-push)"
echo "pull identity reads digest: exit $pr (want 0) -> $(kn logs verify -c pull-reads 2>/dev/null | tail -1)"
echo "push-$DOMAIN writes apps/other-domain: exit $po (want != 0) -> $(kn logs verify -c push-other-domain 2>/dev/null | tail -1 | cut -c1-160)"
echo "anonymous push: exit $an (want != 0) -> $(kn logs verify -c anonymous-push 2>/dev/null | tail -1 | cut -c1-160)"
[ "$pr" = 0 ] && [ "$po" != 0 ] && [ -n "$po" ] && [ "$an" != 0 ] && [ -n "$an" ] || { echo "FAIL: registry identity checks" >&2; exit 1; }

say "EVIDENCE"
cat <<EOF
cluster:        $server
node(s):        $node
seccomp:        $SECCOMP${LOCALHOST_PROFILE:+ ($LOCALHOST_PROFILE)}
build pod:      hostUsers=false, PSS baseline namespace, no privileged, no added capability, no Secret, no SA token
builder image:  $BUILDER_IMAGE
app image:      ${zot}/apps/${DOMAIN}/${SLUG}@${digest}
EOF
echo "PROOF OK"
