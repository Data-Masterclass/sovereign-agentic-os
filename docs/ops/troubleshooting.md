# Troubleshooting an install

Symptoms seen on real installs, their cause, and the fix. Server and reverse-proxy setup:
[reverse-proxy.md](reverse-proxy.md).

## Sign-in page reloads, no error

**Symptom:** you open the OS on `http://<server>:8080` (or on a host name the OS does not know),
sign in with correct credentials, and land back on the sign-in page.

**Cause:** the session cookie is `Secure` in production, and browsers drop a `Secure` cookie set
over plain HTTP on any host except `localhost`. Or the address you opened is not `osUI.publicUrl`
nor in `osUI.publicUrlAliases`.

**What you see now:** the sign-in page says which of the two it is, and os-ui logs one line:

```bash
kubectl -n agentic-os logs deploy/os-ui | grep '\[auth\] WARN'
```

**Fix:** HTTPS in front of os-ui and `osUI.publicUrl` set to that address
([reverse-proxy.md](reverse-proxy.md)); add other names to `osUI.publicUrlAliases`. For a
throw-away test on a trusted network only: `osUI.insecureSessionCookie=true`.

## egress-proxy: "Could not open config file"

**Symptom:** on an Ubuntu host (seen with kind), the `egress-proxy` pod crash-loops and its log
says it cannot open `/etc/tinyproxy/tinyproxy.conf`, although the ConfigMap is mounted and
readable.

**Cause:** the host has an AppArmor profile for tinyproxy that attaches by executable **path**
(`/usr/bin/tinyproxy`). AppArmor attaches a profile by path when an **unconfined** process executes
a matching file. Under kind the pods run on the host kernel, and when the node's container runtime
applies no AppArmor profile of its own, the container's processes are unconfined. So the proxy
started from `/usr/bin/tinyproxy` inside the container got the **host's** tinyproxy profile, which
does not allow the container's paths, and every file read was denied. The error message hides
the AppArmor denial.

**Check on the host:**

```bash
sudo aa-status | grep -i tinyproxy                       # the host profile is loaded
sudo journalctl -k | grep -i 'apparmor="DENIED"' | grep -i tinyproxy   # the denials
```

**Fixed in the image (egress-proxy 0.1.1):** the binary now lives at
`/opt/egress-proxy/egress-proxy` (same unmodified Alpine package, moved), so no host profile names
it (`images/base/egress-proxy/Dockerfile`). Rebuild and load the image (`./scripts/os up` builds it
with the tag from `values.yaml`), or, on an older image, unload the host profile for the test
(`sudo aa-disable /etc/apparmor.d/<the tinyproxy profile>`) and re-enable it afterwards.

The same class of problem can hit any image whose binary has a path-attached profile on the host.
`journalctl -k | grep DENIED` is the quickest check whenever a container reports "permission
denied" or "cannot open" for a file that is plainly there.

### Why the chart does not set `appArmorProfile: RuntimeDefault`

`securityContext.appArmorProfile.type: RuntimeDefault` (stable in Kubernetes since 1.31) asks the
container runtime to start the container under **its own** default profile. A process that is
already confined follows its profile's rules when it executes a program, and path attachment only
applies to unconfined processes, so a host profile like the tinyproxy one would no longer attach.
It also adds a baseline confinement to every container.

It is not set by the chart, because the kubelet checks that AppArmor is enabled before it admits a
pod that configures AppArmor explicitly
([Kubernetes AppArmor tutorial](https://kubernetes.io/docs/tutorials/security/apparmor/)). On hosts
without AppArmor (SELinux distributions such as RHEL) the pods would not be admitted. Inside kind,
the node's runtime may also be unable to load its default profile. The image fix above works on
every host without that risk. Operators whose nodes all run AppArmor can add the field with a
Helm post-renderer or a kustomize patch, after testing it on one node.
