{{- /*
  APP BUILDER SWITCH (W0; docs/superpowers/specs/2026-11-26-app-builder-design.md section 2a). Included by
  soa.osUI.runEnv (_os-ui-env.tpl), so os-ui and os-ui-worker read the same flag.
  `softwareRunner.environments.enabled: true` renders SOFTWARE_APP_BUILDER=on; false or ABSENT (also under
  `--reuse-values` from a release that predates the block) renders NOTHING AT ALL, so the os-ui environment, and
  therefore the pod template, is byte-identical to a chart without the App Builder and no pod restarts.
*/}}
{{- define "soa.osUI.env.appBuilder" -}}
{{- if ((.Values.softwareRunner | default dict).environments | default dict).enabled | default false }}
# ---- App Builder (spec 2a): ON. Off renders nothing here. ----
- name: SOFTWARE_APP_BUILDER
  value: "on"
{{- end }}
{{- end }}
