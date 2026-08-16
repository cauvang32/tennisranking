#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
namespace="${K3S_NAMESPACE:-tennis-prod}"
"${repo_root}/scripts/k3s/preflight.sh"

echo "This rolls back Deployments only. It never reverses a database migration."
kubectl -n "${namespace}" rollout undo deployment/tennis-app
kubectl -n "${namespace}" rollout undo deployment/tennis-fcm-worker
kubectl -n "${namespace}" rollout status deployment/tennis-app --timeout=10m
kubectl -n "${namespace}" rollout status deployment/tennis-fcm-worker --timeout=10m
