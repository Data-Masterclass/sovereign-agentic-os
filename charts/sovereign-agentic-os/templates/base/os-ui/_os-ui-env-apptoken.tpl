{{- /*
  APP BUILDER: the app identity token (D1) for os-ui (owner: workstream E). STUB created by W0: renders nothing. E
  fills it and MUST keep it empty while `softwareRunner.environments.enabled` is false (spec 2a). Keys it renders
  (read by core/kernel/config.ts): OS_APP_TOKEN_KEY_FILE, OS_APP_TOKEN_ISSUER. Included by soa.osUI.adminEnv ONLY:
  the signing key is an HTTP-path credential the run worker must not hold (same rule as the session key).
*/}}
{{- define "soa.osUI.env.appToken" -}}
{{- end }}
