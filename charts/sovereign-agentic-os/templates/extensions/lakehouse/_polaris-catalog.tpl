{{- /*
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)

  soa.polarisEnsureCatalogContainer (dict "ctx" $ "name" "<container name>") — ONE container spec that
  makes sure the Polaris catalog `polaris.catalog.name` exists (management API: GET, then POST
  /api/management/v1/catalogs when missing, or PUT to converge its storage config), idempotent.
  Used by the polaris-catalog-init hook AND as the first initContainer of every Job that USES the
  catalog (northpeak-marts-init), so a Job never depends on the catalog having survived since an
  earlier hook ran (an in-memory Polaris that restarted in between lost it: "Unable to find
  warehouse lakehouse", pilot install). Root principal credentials; nothing else.
*/}}
{{- define "soa.polarisEnsureCatalogContainer" -}}
{{- $ctx := .ctx }}{{- $name := .name }}
{{- $pl := $ctx.Values.polaris }}
{{- $cat := $pl.catalog.name -}}
- name: {{ $name }}
  image: "{{ $pl.bootstrapImage.repository }}:{{ $pl.bootstrapImage.tag }}{{ if $pl.bootstrapImage.digest }}@{{ $pl.bootstrapImage.digest }}{{ end }}"
  imagePullPolicy: {{ $ctx.Values.global.imagePullPolicy }}
  securityContext:
    {{- include "soa.containerSecurityContext" $ctx | nindent 4 }}
  env:
    {{- if eq $ctx.Values.global.profile "local" }}
    # Root principal (same creds as POLARIS_BOOTSTRAP_CREDENTIALS), templated
    # like trino-catalog-credentials does for the OAuth client.
    - name: CLIENT_ID
      value: {{ $pl.local.rootClientId | quote }}
    - name: CLIENT_SECRET
      value: {{ $pl.local.rootClientSecret | quote }}
    {{- else }}
    # Non-local: parse clientId/clientSecret out of "realm,clientId,clientSecret".
    - name: BOOTSTRAP_CREDS
      valueFrom: { secretKeyRef: { name: {{ $pl.secretName }}, key: POLARIS_BOOTSTRAP_CREDENTIALS } }
    {{- end }}
    # Static S3 creds for the catalog's FileIO (no STS on MinIO/Object Storage).
    - name: AWS_ACCESS_KEY_ID
      valueFrom: { secretKeyRef: { name: {{ $ctx.Values.objectStorage.secretName }}, key: AWS_ACCESS_KEY_ID } }
    - name: AWS_SECRET_ACCESS_KEY
      valueFrom: { secretKeyRef: { name: {{ $ctx.Values.objectStorage.secretName }}, key: AWS_SECRET_ACCESS_KEY } }
    - name: CATALOG
      value: {{ $cat | quote }}
    - name: BASE_LOCATION
      value: {{ $pl.catalog.baseLocation | quote }}
    - name: S3_ENDPOINT
      value: {{ include "soa.s3Endpoint" $ctx | quote }}
    - name: S3_REGION
      value: {{ $pl.s3.region | quote }}
    - name: POLARIS_CATALOG_API
      value: "http://polaris:8181"
    - name: POLARIS_MGMT
      value: "http://polaris:8182"
  command: ["/bin/sh", "-c"]
  args:
    - |
      set -eu
      : "${CLIENT_ID:=$(printf '%s' "${BOOTSTRAP_CREDS:-}" | cut -d, -f2)}"
      : "${CLIENT_SECRET:=$(printf '%s' "${BOOTSTRAP_CREDS:-}" | cut -d, -f3)}"

      echo "waiting for Polaris to be ready ..."
      for i in $(seq 1 60); do
        if curl -fsS "$POLARIS_MGMT/q/health/ready" >/dev/null 2>&1; then
          echo "Polaris is ready"; break
        fi
        sleep 5
      done

      echo "obtaining OAuth2 token ..."
      TOKEN=$(curl -fsS -X POST "$POLARIS_CATALOG_API/api/catalog/v1/oauth/tokens" \
        -d grant_type=client_credentials \
        -d "client_id=$CLIENT_ID" \
        -d "client_secret=$CLIENT_SECRET" \
        -d scope=PRINCIPAL_ROLE:ALL \
        | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
      if [ -z "$TOKEN" ]; then echo "ERROR: could not obtain Polaris token"; exit 1; fi

      # The `lakehouse` catalog persists across upgrades in the JDBC metastore, so on
      # an existing cluster it is ALREADY registered. Polaris 1.1.0 fixes new-table
      # writes via endpointInternal + pathStyleAccess on the catalog's
      # storageConfigInfo (the NEW 1.1.0 AwsStorageConfigInfo fields), so the server's
      # OWN write/commit FileIO uses path-style S3 on every table-create path. We
      # therefore do NOT just short-circuit on "exists": GET the catalog and, if it
      # lacks pathStyleAccess, PUT-update its storageConfigInfo IN PLACE. This never
      # drops the catalog (a DELETE would fail anyway while it holds the mart + dataset
      # registrations) — existing tables keep their metadata; only NEW creates pick up
      # the endpoint/path-style. Idempotent: once pathStyleAccess=true is present,
      # subsequent Argo syncs are a no-op.
      existing=$(curl -s -w '\n%{http_code}' \
        -H "Authorization: Bearer $TOKEN" \
        "$POLARIS_CATALOG_API/api/management/v1/catalogs/$CATALOG")
      code=$(printf '%s' "$existing" | tail -n1)
      body=$(printf '%s' "$existing" | sed '$d')
      if [ "$code" = "200" ]; then
        if printf '%s' "$body" | grep -q '"pathStyleAccess":true'; then
          echo "catalog $CATALOG already has pathStyleAccess — nothing to do"; exit 0
        fi
        ver=$(printf '%s' "$body" | sed -n 's/.*"entityVersion":\([0-9]*\).*/\1/p')
        # Polaris UpdateCatalog REPLACES the properties map wholesale: a PUT that
        # sends only storageConfigInfo WIPES every s3.* / table-default.s3.*
        # catalog property (this happened live and briefly broke reads). So the
        # update PUT is NEVER storageConfigInfo-only: take the catalog's CURRENT
        # properties from the GET above, drop the s3/table-default keys this Job
        # owns, re-add them at the desired values, and send the FULL merged map
        # alongside storageConfigInfo. Everything else (default-base-location,
        # access keys, operator-added keys) is preserved byte-for-byte.
        props=$(printf '%s' "$body" | sed -n 's/.*"properties":{\([^}]*\)}.*/\1/p')
        for k in 's3\.endpoint' 's3\.path-style-access' 's3\.region' \
                 'table-default\.s3\.endpoint' 'table-default\.s3\.path-style-access' 'table-default\.s3\.region'; do
          props=$(printf '%s' "$props" | sed 's/"'"$k"'":"[^"]*"//g')
        done
        props=$(printf '%s' "$props" | sed 's/,,*/,/g; s/^,//; s/,$//')
        managed='"s3.endpoint":"'"$S3_ENDPOINT"'","s3.path-style-access":"true","s3.region":"'"$S3_REGION"'","table-default.s3.endpoint":"'"$S3_ENDPOINT"'","table-default.s3.path-style-access":"true","table-default.s3.region":"'"$S3_REGION"'"'
        if [ -n "$props" ]; then merged="$props,$managed"; else merged="$managed"; fi
        echo "catalog $CATALOG exists (entityVersion=$ver) — updating storageConfigInfo + FULL properties map"
        curl -fsS -X PUT \
          -H "Authorization: Bearer $TOKEN" \
          -H "Content-Type: application/json" \
          "$POLARIS_CATALOG_API/api/management/v1/catalogs/$CATALOG" \
          -d '{
            "currentEntityVersion": '"$ver"',
            "properties": {'"$merged"'},
            "storageConfigInfo": {
              "storageType": "S3",
              "roleArn": "arn:aws:iam::000000000000:role/polaris-lakehouse",
              "allowedLocations": ["'"$BASE_LOCATION"'", "'"$BASE_LOCATION"'/*"],
              "endpointInternal": "'"$S3_ENDPOINT"'",
              "pathStyleAccess": true
            }
          }'
        echo "catalog $CATALOG updated — path-style storage config + s3/table-default properties ensured"; exit 0
      fi

      echo "registering catalog $CATALOG -> $BASE_LOCATION"
      curl -fsS -X POST \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        "$POLARIS_CATALOG_API/api/management/v1/catalogs" \
        -d '{
          "catalog": {
            "name": "'"$CATALOG"'",
            "type": "INTERNAL",
            "properties": {
              "default-base-location": "'"$BASE_LOCATION"'",
              "s3.endpoint": "'"$S3_ENDPOINT"'",
              "s3.path-style-access": "true",
              "s3.region": "'"$S3_REGION"'",
              "s3.access-key-id": "'"$AWS_ACCESS_KEY_ID"'",
              "s3.secret-access-key": "'"$AWS_SECRET_ACCESS_KEY"'",
              "table-default.s3.endpoint": "'"$S3_ENDPOINT"'",
              "table-default.s3.path-style-access": "true",
              "table-default.s3.region": "'"$S3_REGION"'"
            },
            "storageConfigInfo": {
              "storageType": "S3",
              "roleArn": "arn:aws:iam::000000000000:role/polaris-lakehouse",
              "allowedLocations": ["'"$BASE_LOCATION"'", "'"$BASE_LOCATION"'/*"],
              "endpointInternal": "'"$S3_ENDPOINT"'",
              "pathStyleAccess": true
            }
          }
        }'
      echo "catalog $CATALOG registered"
  resources:
    requests: { cpu: 25m, memory: 64Mi }
    limits: { cpu: 200m, memory: 128Mi }
{{- end -}}
