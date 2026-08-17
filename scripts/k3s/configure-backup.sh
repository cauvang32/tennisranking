#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
namespace="${K3S_NAMESPACE:-tennis-prod}"
destination="${K3S_S3_DESTINATION:?Set K3S_S3_DESTINATION, for example s3://bucket/tennis-prod}"
endpoint="${K3S_S3_ENDPOINT:?Set K3S_S3_ENDPOINT to an HTTPS S3-compatible endpoint}"
: "${K3S_S3_ACCESS_KEY:?Set K3S_S3_ACCESS_KEY}"
: "${K3S_S3_SECRET_KEY:?Set K3S_S3_SECRET_KEY}"

"${repo_root}/scripts/k3s/preflight.sh"
if [[ ! "${destination}" =~ ^s3://[A-Za-z0-9._/-]+$ ]]; then
  echo "K3S_S3_DESTINATION contains unsupported characters." >&2
  exit 1
fi
if [[ ! "${endpoint}" =~ ^https://[A-Za-z0-9._:/-]+$ ]]; then
  echo "K3S_S3_ENDPOINT must be a simple HTTPS URL." >&2
  exit 1
fi

kubectl -n "${namespace}" create secret generic tennis-s3-backup \
  --from-literal=ACCESS_KEY_ID="${K3S_S3_ACCESS_KEY}" \
  --from-literal=ACCESS_SECRET_KEY="${K3S_S3_SECRET_KEY}" \
  --dry-run=client -o yaml | kubectl apply -f -

sed -e "s|__DESTINATION_PATH__|${destination}|g" \
  -e "s|__ENDPOINT_URL__|${endpoint}|g" \
  "${repo_root}/deploy/k3s/backup/object-store.yaml.template" | kubectl apply -f -

kubectl -n "${namespace}" patch cluster tennis-postgres --type=merge --patch \
  '{"spec":{"plugins":[{"name":"barman-cloud.cloudnative-pg.io","isWALArchiver":true,"parameters":{"barmanObjectName":"tennis-postgres-backup"}}]}}'
kubectl -n "${namespace}" wait --for=condition=Ready cluster/tennis-postgres --timeout=15m

backup_name="tennis-precutover-$(date +%Y%m%d%H%M%S)"
kubectl -n "${namespace}" create -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: ${backup_name}
spec:
  cluster:
    name: tennis-postgres
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
EOF
kubectl -n "${namespace}" wait --for=condition=Completed "backup/${backup_name}" --timeout=30m
kubectl -n "${namespace}" get "backup/${backup_name}" -o wide
echo "Off-site PostgreSQL backup completed. Perform a restore drill before cutover."
