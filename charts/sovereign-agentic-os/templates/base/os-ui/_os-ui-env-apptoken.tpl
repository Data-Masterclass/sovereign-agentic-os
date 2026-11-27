{{- /*
  APP BUILDER: the app identity token (D1) for os-ui (owner: workstream E; spec section 8). Renders NOTHING while
  `softwareRunner.environments.enabled` is false (spec 2a): no env line, no mount, no volume, so the os-ui pod
  template is byte-identical and nothing restarts. Keys it renders (read by core/kernel/config.ts):
  OS_APP_TOKEN_KEY_FILE, OS_APP_TOKEN_ISSUER. Included by soa.osUI.adminEnv ONLY: the signing key is an HTTP-path
  credential the run worker must not hold (same rule as the session key); the mount is on the os-ui container only.

  The key: Secret `osUI.appToken.existingSecret` (default `os-app-token-key`), key `osUI.appToken.key` (default
  `keys.json`), an Ed25519 private JWK set whose FIRST key signs (rotation: add a key in front, drop the old one
  after 15 minutes). It is created out of band (scripts/dev/bootstrap-secrets.sh on dev, an ExternalSecret
  elsewhere) and is REQUIRED while the App Builder is on: the volume is not optional, so a missing Secret keeps the
  new pod from starting instead of serving app sign-in without a key.
*/}}
{{- define "soa.osUI.appToken.on" -}}
{{- if ((.Values.softwareRunner | default dict).environments | default dict).enabled | default false }}on{{- end }}
{{- end }}

{{- define "soa.osUI.appToken.mountPath" -}}/var/run/secrets/os-app-token{{- end }}

{{- define "soa.osUI.env.appToken" -}}
{{- if include "soa.osUI.appToken.on" . }}
{{- $at := .Values.osUI.appToken | default dict }}
# ---- App Builder (spec section 8): the app identity token signing key (a mounted file) and issuer. ----
- name: OS_APP_TOKEN_KEY_FILE
  value: {{ printf "%s/%s" (include "soa.osUI.appToken.mountPath" .) ($at.key | default "keys.json") | quote }}
{{- with $at.issuer }}
- name: OS_APP_TOKEN_ISSUER
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- end }}

{{- /* The os-ui container's mount of the key (nothing while the App Builder is off). */}}
{{- define "soa.osUI.appToken.mounts" -}}
{{- if include "soa.osUI.appToken.on" . }}
- name: os-app-token-key
  mountPath: {{ include "soa.osUI.appToken.mountPath" . }}
  readOnly: true
{{- end }}
{{- end }}

{{- /* The pod volume of the key (nothing while the App Builder is off). */}}
{{- define "soa.osUI.appToken.volumes" -}}
{{- if include "soa.osUI.appToken.on" . }}
{{- $at := .Values.osUI.appToken | default dict }}
- name: os-app-token-key
  secret:
    secretName: {{ $at.existingSecret | default "os-app-token-key" | quote }}
    # 0440: root-owned, group = the pod fsGroup (1000) the os-ui user runs in; nobody else reads the key.
    defaultMode: 0440
    items:
      - key: {{ $at.key | default "keys.json" | quote }}
        path: {{ $at.key | default "keys.json" | quote }}
{{- end }}
{{- end }}
