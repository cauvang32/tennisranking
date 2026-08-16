#!/usr/bin/env bash
set -Eeuo pipefail

namespace="${K3S_NAMESPACE:-tennis-prod}"
expected_context="${K3S_CONTEXT:?Set K3S_CONTEXT to the exact kubectl context name}"
mode="${K3S_MODE:-ha}"

for command in kubectl sed; do
  command -v "${command}" >/dev/null || { echo "Missing command: ${command}" >&2; exit 1; }
done

current_context="$(kubectl config current-context)"
if [[ "${current_context}" != "${expected_context}" ]]; then
  echo "Refusing cluster mutation: current context '${current_context}', expected '${expected_context}'." >&2
  exit 1
fi
if [[ "${K3S_CONFIRM_CLUSTER:-}" != "${expected_context}" ]]; then
  echo "Set K3S_CONFIRM_CLUSTER=${expected_context} to confirm this target." >&2
  exit 1
fi

kubectl cluster-info >/dev/null
ready_nodes="$(kubectl get nodes --no-headers | awk '$2 ~ /^Ready/ {count++} END {print count+0}')"
if [[ "${mode}" == "ha" && "${ready_nodes}" -lt 3 ]]; then
  echo "HA mode requires at least 3 Ready nodes; found ${ready_nodes}." >&2
  exit 1
fi
if kubectl -n kube-system get deployment traefik >/dev/null 2>&1; then
  echo "Traefik is installed. This deployment requires K3s Traefik to be disabled." >&2
  exit 1
fi

echo "Preflight passed for ${current_context}: ${ready_nodes} Ready node(s), namespace ${namespace}."
