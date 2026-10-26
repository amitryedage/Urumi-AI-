{{- define "store.name" -}}{{ default .Release.Name .Values.nameOverride | trunc 40 | trimSuffix "-" }}{{- end -}}

{{- define "store.labels" -}}
app.kubernetes.io/part-of: urumi-store
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "store.selector" -}}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "store.dbHost" -}}{{ include "store.name" . }}-mariadb{{- end -}}
{{- define "store.wpHost" -}}{{ include "store.name" . }}-wordpress{{- end -}}

{{- define "store.containerSecurity" -}}
allowPrivilegeEscalation: false
capabilities: { drop: ["ALL"] }
{{- end -}}
