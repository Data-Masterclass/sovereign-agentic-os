{{- /*
  LITELLM_SALT_KEY — the key LiteLLM encrypts database-stored credentials with (models added in
  the console or through /model/new, stored credentials, MCP server credentials). Without it
  LiteLLM falls back to the MASTER key (litellm/proxy/common_utils/encrypt_decrypt_utils.py
  `_get_salt_key`), so a master-key rotation would make those values undecryptable.
  docs/ops/litellm-salt-key.md has the full analysis; docs/ops/secret-rotation.md the procedure.

  Once set, it must NEVER change (LiteLLM's own rule): values encrypted with the old salt are
  silently dropped from the model list. Hence the guards below.

  Sources, in order:
    * local profile: `litellmSaltKey.value`, rendered into `litellm-credentials` as
      LITELLM_SALT_KEY (envFrom → the gateway container, via `litellm.environmentSecrets`).
      Empty = not set (a laptop install keeps working as before).
    * any other profile: the chart does not render `litellm-credentials`, so the salt must come
      from a Secret the operator manages (ESO): `litellmSaltKey.existingSecret`, holding key
      LITELLM_SALT_KEY and listed in `litellm.environmentSecrets`. REQUIRED there.

  The change guard (`lookup`) runs on `helm install/upgrade` (and `--dry-run=server`): when the
  live `litellm-credentials` already holds a LITELLM_SALT_KEY, a different value — or none —
  fails the render. `litellmSaltKey.allowChange=true` is the one deliberate exception:
  re-creating every stored value under a new salt (litellm-salt-key.md, C), passed once with
  --set, never left in an overlay. A rollback keeps the salt key (docs/ops/secret-rotation.md):
  Helm does not remove a key from a live Secret's data when it disappears from stringData.
  `helm template` has no cluster, so the guard is inactive there (GitOps renderers likewise).
  No value is ever printed: the messages name keys only.
*/}}
{{- define "soa.litellm.saltKey" -}}
{{- $s := .Values.litellmSaltKey | default dict -}}
{{- $value := $s.value | default "" -}}
{{- if ne .Values.global.profile "local" -}}
  {{- if $value -}}
    {{- fail "litellmSaltKey.value is rendered only on the local profile (the chart does not render litellm-credentials here). Put LITELLM_SALT_KEY into the operator-managed Secret and set litellmSaltKey.existingSecret to its name." -}}
  {{- end -}}
  {{- if not $s.existingSecret -}}
    {{- fail (printf "litellmSaltKey.existingSecret is required on the %q profile: name the Secret (key LITELLM_SALT_KEY) that the gateway reads through litellm.environmentSecrets. Without it LiteLLM encrypts stored credentials with the master key and a master-key rotation loses them (docs/ops/litellm-salt-key.md)." .Values.global.profile) -}}
  {{- end -}}
  {{- if not (has $s.existingSecret (.Values.litellm.environmentSecrets | default list)) -}}
    {{- fail (printf "litellmSaltKey.existingSecret %q is not listed in litellm.environmentSecrets, so the gateway would never see LITELLM_SALT_KEY." $s.existingSecret) -}}
  {{- end -}}
{{- else -}}
  {{- if $s.existingSecret -}}
    {{- fail "litellmSaltKey.existingSecret is for the non-local profiles; on the local profile set litellmSaltKey.value (it is rendered into litellm-credentials)." -}}
  {{- end -}}
  {{- $live := lookup "v1" "Secret" .Release.Namespace "litellm-credentials" -}}
  {{- $current := "" -}}
  {{- if and $live $live.data (hasKey $live.data "LITELLM_SALT_KEY") -}}
    {{- $current = index $live.data "LITELLM_SALT_KEY" | b64dec -}}
  {{- end -}}
  {{- if and $current (ne $current $value) (not $s.allowChange) -}}
    {{- if $value -}}
      {{- fail "LITELLM_SALT_KEY_CHANGE_REFUSED: litellmSaltKey.value differs from the LITELLM_SALT_KEY already in the live litellm-credentials Secret. Once set it must never change: every database-stored model credential would become undecryptable. Keep the current value, also in a rollback (docs/ops/secret-rotation.md); only a full re-key sets litellmSaltKey.allowChange=true." -}}
    {{- else -}}
      {{- fail "LITELLM_SALT_KEY_CHANGE_REFUSED: the live litellm-credentials Secret holds a LITELLM_SALT_KEY but litellmSaltKey.value is empty, which would remove it. Keep passing the current value (deploy.sh carries it over from the live release values); only a full re-key sets litellmSaltKey.allowChange=true." -}}
    {{- end -}}
  {{- end -}}
  {{- $value -}}
{{- end -}}
{{- end -}}
