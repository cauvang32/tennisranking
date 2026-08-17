#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
"${repo_root}/scripts/k3s/preflight.sh"

wait_for_resource() {
  local resource="$1"
  local namespace="${2:-}"
  local timeout_seconds="${3:-600}"
  local elapsed=0
  local get_args=(get "${resource}")

  if [[ -n "${namespace}" ]]; then
    get_args=(-n "${namespace}" get "${resource}")
  fi

  until kubectl "${get_args[@]}" >/dev/null 2>&1; do
    if (( elapsed >= timeout_seconds )); then
      echo "Timed out waiting for ${resource} to be created${namespace:+ in namespace ${namespace}}." >&2
      kubectl -n kube-system get helmcharts,jobs,pods >&2 || true
      return 1
    fi
    sleep 5
    ((elapsed += 5))
  done
}

wait_for_crd() {
  local crd="$1"

  wait_for_resource "crd/${crd}" "" 600
  kubectl wait --for=condition=Established "crd/${crd}" --timeout=10m
}

wait_for_deployment() {
  local namespace="$1"
  local deployment="$2"
  local timeout="$3"

  wait_for_resource "deployment/${deployment}" "${namespace}" 900
  kubectl -n "${namespace}" rollout status "deployment/${deployment}" --timeout="${timeout}"
}

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
  wait_for_crd "${crd}"
done
wait_for_deployment longhorn-system longhorn-driver-deployer 15m
wait_for_deployment cnpg-system cloudnative-pg 10m
wait_for_deployment redis-operator redis-operator 10m

echo "Installing the pinned CloudNativePG Barman Cloud backup plugin..."
kubectl apply -f https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.13.0/manifest.yaml
wait_for_crd objectstores.barmancloud.cnpg.io
wait_for_deployment cnpg-system barman-cloud 10m

echo "K3s platform operators are ready. Configure off-site backup before production cutover."
