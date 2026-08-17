#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
namespace="${K3S_NAMESPACE:-tennis-prod}"
image="${K3S_IMAGE:?Set K3S_IMAGE to an immutable image digest}"
renderer="${repo_root}/scripts/k3s/render-manifest.sh"

"${repo_root}/scripts/k3s/preflight.sh"
if [[ ! "${image}" =~ @sha256:[a-f0-9]{64}$ ]]; then
  echo "K3S_IMAGE must use an immutable @sha256 digest." >&2
  exit 1
fi

kubectl apply -f "${repo_root}/deploy/k3s/base/namespace.yaml"
"${repo_root}/scripts/k3s/create-secrets.sh"
kubectl apply -f "${repo_root}/deploy/k3s/base/config.yaml"
kubectl apply -f "${repo_root}/deploy/k3s/base/storage.yaml"
kubectl apply -f "${repo_root}/deploy/k3s/base/network-policy.yaml"
"${renderer}" "${repo_root}/deploy/k3s/base/postgres.yaml" | kubectl apply -f -
"${renderer}" "${repo_root}/deploy/k3s/base/redis.yaml" | kubectl apply -f -

echo "Waiting for PostgreSQL and Redis data services..."
kubectl -n "${namespace}" wait --for=condition=Ready cluster/tennis-postgres --timeout=20m
for service in tennis-postgres-rw redis-cache-master redis-queue-master; do
  until kubectl -n "${namespace}" get endpoints "${service}" -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null | grep -q .; do
    echo "Waiting for endpoint ${service}..."
    sleep 5
  done
done

if [[ "${K3S_PREPARE_ONLY:-false}" == "true" ]]; then
  echo "Data services are ready in prepare-only mode. No schema migration or app/FCM pod was started."
  exit 0
fi

"${repo_root}/scripts/k3s/run-migration.sh"

for manifest in app.yaml fcm-worker.yaml; do
  "${renderer}" "${repo_root}/deploy/k3s/base/${manifest}" "${image}" | kubectl apply -f -
done

kubectl -n "${namespace}" rollout status deployment/tennis-app --timeout=10m
kubectl -n "${namespace}" rollout status deployment/tennis-fcm-worker --timeout=10m
kubectl -n "${namespace}" get pods,svc,pvc
echo "Deployment ready. Do not change NPMplus until the pre-cutover backup and smoke tests pass."
