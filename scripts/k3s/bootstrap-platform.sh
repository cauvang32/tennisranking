#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
"${repo_root}/scripts/k3s/preflight.sh"

if [[ "${K3S_MODE:-ha}" == "single" ]]; then
  # New volumes use one Longhorn replica while learning on one physical node.
  # The count must be raised for both the default and existing volumes during
  # a later HA promotion.
  kubectl kustomize "${repo_root}/deploy/k3s/platform" | \
    sed 's/defaultClassReplicaCount: 3/defaultClassReplicaCount: 1/' | \
    kubectl apply -f -
else
  kubectl apply -k "${repo_root}/deploy/k3s/platform"
fi

echo "Waiting for platform CRDs..."
for crd in clusters.postgresql.cnpg.io redisreplications.redis.redis.opstreelabs.in redissentinels.redis.redis.opstreelabs.in; do
  kubectl wait --for=condition=Established "crd/${crd}" --timeout=10m
done
kubectl -n longhorn-system rollout status deployment/longhorn-driver-deployer --timeout=15m
kubectl -n cnpg-system rollout status deployment/cloudnative-pg --timeout=10m
kubectl -n redis-operator rollout status deployment/redis-operator --timeout=10m

echo "Installing the pinned CloudNativePG Barman Cloud backup plugin..."
kubectl apply -f https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.13.0/manifest.yaml
kubectl wait --for=condition=Established crd/objectstores.barmancloud.cnpg.io --timeout=10m
kubectl -n cnpg-system rollout status deployment/barman-cloud --timeout=10m

echo "K3s platform operators are ready. Configure off-site backup before production cutover."
