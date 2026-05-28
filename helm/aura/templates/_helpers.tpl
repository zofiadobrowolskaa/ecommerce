{{/*
  helper templates shared across the chart.
  underscore prefix tells helm to treat this file as a partials library, not a manifest.
*/}}

{{/*
  fully qualified image reference for a given service.
  usage: image: {{ include "aura.image" (dict "service" "api-gateway" "root" .) }}
*/}}
{{- define "aura.image" -}}
{{- printf "%s/aura-%s:%s" .root.Values.image.registry .service .root.Values.image.tag -}}
{{- end -}}

{{/*
  standard labels applied to every resource, makes kubectl filtering predictable.
*/}}
{{- define "aura.labels" -}}
app.kubernetes.io/name: aura
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
aura.environment: {{ .Values.environment }}
{{- end -}}
