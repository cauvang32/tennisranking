#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
namespace="${K3S_NAMESPACE:-tennis-prod}"
image="${K3S_IMAGE:?Set K3S_IMAGE to an immutable image digest}"
suffix="${CI_PIPELINE_ID:-manual-$(date +%s)}"
job_name="tennis-migrate-${suffix//[^a-zA-Z0-9-]/-}"

if [[ ! "${image}" =~ @sha256:[a-f0-9]{64}$ ]]; then
  echo "K3S_IMAGE must use an immutable @sha256 digest, got: ${image}" >&2
  exit 1
fi

sed -e "s|__IMAGE__|${image}|g" -e "s|__JOB_NAME__|${job_name}|g" \
  "${repo_root}/deploy/k3s/jobs/migration-job.yaml" | kubectl apply -f -

if ! kubectl -n "${namespace}" wait --for=condition=complete "job/${job_name}" --timeout=30m; then
  kubectl -n "${namespace}" logs "job/${job_name}" --all-containers=true || true
  kubectl -n "${namespace}" describe "job/${job_name}" || true
  exit 1
fi
kubectl -n "${namespace}" logs "job/${job_name}" --all-containers=true
