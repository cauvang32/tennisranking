#!/usr/bin/env bash
set -Eeuo pipefail

namespace="${K3S_NAMESPACE:-tennis-prod}"
firebase_file="${K3S_FIREBASE_SERVICE_ACCOUNT_FILE:-firebase-service-account.json}"

required=(
  K3S_DB_PASSWORD K3S_REDIS_PASSWORD
  ADMIN_USERNAME ADMIN_PASSWORD EDITOR_USERNAME EDITOR_PASSWORD
  JWT_SECRET CSRF_SECRET
  K3S_REGISTRY_USER K3S_REGISTRY_PASSWORD
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Required environment variable is missing: ${name}" >&2
    exit 1
  fi
done

if [[ ! "${K3S_REDIS_PASSWORD}" =~ ^[A-Za-z0-9_-]{24,}$ ]]; then
  echo "K3S_REDIS_PASSWORD must be 24+ URL-safe characters: A-Z, a-z, 0-9, _ or -." >&2
  exit 1
fi
if [[ ! -s "${firebase_file}" ]]; then
  echo "Firebase service-account file not found or empty: ${firebase_file}" >&2
  exit 1
fi

runtime_file="$(mktemp)"
trap 'rm -f "${runtime_file}"' EXIT
chmod 600 "${runtime_file}"
{
  printf 'DB_PASSWORD=%s\n' "${K3S_DB_PASSWORD}"
  printf 'REDIS_URL=redis://:%s@redis-cache-master:6379/0\n' "${K3S_REDIS_PASSWORD}"
  printf 'QUEUE_REDIS_URL=redis://:%s@redis-queue-master:6379/0\n' "${K3S_REDIS_PASSWORD}"
  printf 'RATE_LIMIT_REDIS_URL=redis://:%s@redis-queue-master:6379/1\n' "${K3S_REDIS_PASSWORD}"
  printf 'ADMIN_USERNAME=%s\n' "${ADMIN_USERNAME}"
  printf 'ADMIN_PASSWORD=%s\n' "${ADMIN_PASSWORD}"
  printf 'EDITOR_USERNAME=%s\n' "${EDITOR_USERNAME}"
  printf 'EDITOR_PASSWORD=%s\n' "${EDITOR_PASSWORD}"
  printf 'JWT_SECRET=%s\n' "${JWT_SECRET}"
  printf 'CSRF_SECRET=%s\n' "${CSRF_SECRET}"
  [[ -n "${AI_API_KEY:-}" ]] && printf 'AI_API_KEY=%s\n' "${AI_API_KEY}"
  [[ -n "${AI_MODEL:-}" ]] && printf 'AI_MODEL=%s\n' "${AI_MODEL}"
  [[ -n "${AI_BASE_URL:-}" ]] && printf 'AI_BASE_URL=%s\n' "${AI_BASE_URL}"
} > "${runtime_file}"

kubectl create namespace "${namespace}" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "${namespace}" create secret generic tennis-runtime \
  --from-env-file="${runtime_file}" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "${namespace}" create secret generic tennis-db-app \
  --from-literal=username=tennis \
  --from-literal=password="${K3S_DB_PASSWORD}" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "${namespace}" create secret generic tennis-redis \
  --from-literal=password="${K3S_REDIS_PASSWORD}" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "${namespace}" create secret generic tennis-firebase \
  --from-file=service-account.json="${firebase_file}" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "${namespace}" create secret docker-registry gitlab-registry \
  --docker-server=registry.quocanh.tech \
  --docker-username="${K3S_REGISTRY_USER}" \
  --docker-password="${K3S_REGISTRY_PASSWORD}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "K3s application secrets applied to namespace ${namespace}."
