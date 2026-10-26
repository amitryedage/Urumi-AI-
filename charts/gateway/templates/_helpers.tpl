{{- define "gw.labels" -}}
app.kubernetes.io/part-of: urumi-mcp-gateway
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "gw.selector" -}}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "gw.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities: { drop: ["ALL"] }
{{- end -}}

{{/* Simple non-root Node/Nginx workload: Deployment + Service. */}}
{{- define "gw.simpleWorkload" -}}
{{- $root := .root -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ $root.Release.Name }}-{{ .component }}
  labels: {{- include "gw.labels" $root | nindent 4 }}
spec:
  selector: {{- include "gw.selector" (dict "root" $root "component" .component) | nindent 4 }}
  ports:
    - name: http
      port: {{ .port }}
      targetPort: http
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $root.Release.Name }}-{{ .component }}
  labels: {{- include "gw.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
spec:
  replicas: {{ .replicas | default 1 }}
  selector:
    matchLabels: {{- include "gw.selector" (dict "root" $root "component" .component) | nindent 6 }}
  template:
    metadata:
      labels: {{- include "gw.labels" $root | nindent 8 }}
        app.kubernetes.io/component: {{ .component }}
        {{- if .upstream }}
        mcp-gateway/upstream: "true"
        {{- end }}
    spec:
      {{- with $root.Values.imagePullSecrets }}
      imagePullSecrets: {{- toYaml . | nindent 8 }}
      {{- end }}
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: {{ .uid | default 1000 }}
        {{- toYaml $root.Values.podSecurityContext | nindent 8 }}
      containers:
        - name: {{ .component }}
          image: "{{ .values.image.repository }}:{{ .values.image.tag }}"
          imagePullPolicy: {{ .values.image.pullPolicy }}
          securityContext: {{- include "gw.containerSecurity" $root | nindent 12 }}
          {{- with .env }}
          env: {{- toYaml . | nindent 12 }}
          {{- end }}
          ports:
            - name: http
              containerPort: {{ .port }}
          readinessProbe:
            {{- if .tcpProbe }}
            tcpSocket: { port: http }
            {{- else }}
            httpGet: { path: {{ .healthPath | default "/healthz" }}, port: http }
            {{- end }}
            periodSeconds: 10
          livenessProbe:
            {{- if .tcpProbe }}
            tcpSocket: { port: http }
            {{- else }}
            httpGet: { path: {{ .healthPath | default "/healthz" }}, port: http }
            {{- end }}
            initialDelaySeconds: 10
            periodSeconds: 20
          resources: {{- toYaml .values.resources | nindent 12 }}
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
{{- end -}}
