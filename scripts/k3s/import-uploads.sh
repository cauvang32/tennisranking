#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
namespace="${K3S_NAMESPACE:-tennis-prod}"
source_dir="${1:-}"
image="${K3S_IMAGE:?Set K3S_IMAGE to the immutable deployment digest}"

"${repo_root}/scripts/k3s/preflight.sh"
if [[ "${K3S_CONFIRM_UPLOAD_IMPORT:-}" != "${namespace}" ]]; then
  echo "Set K3S_CONFIRM_UPLOAD_IMPORT=${namespace} to confirm the upload copy." >&2
  exit 1
fi
if [[ -z "${source_dir}" || ! -d "${source_dir}" ]]; then
  echo "Usage: $0 /absolute/path/to/current/uploads" >&2
  exit 1
fi
if [[ ! "${image}" =~ @sha256:[a-f0-9]{64}$ ]]; then
  echo "K3S_IMAGE must use an immutable @sha256 digest." >&2
  exit 1
fi

kubectl -n "${namespace}" delete pod tennis-upload-import --ignore-not-found --wait=true
sed "s|__IMAGE__|${image}|g" "${repo_root}/deploy/k3s/jobs/upload-import-pod.yaml" | kubectl apply -f -
trap 'kubectl -n "${namespace}" delete pod tennis-upload-import --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT
kubectl -n "${namespace}" wait --for=condition=Ready pod/tennis-upload-import --timeout=5m
tar -C "${source_dir}" -cf - . | kubectl -n "${namespace}" exec -i tennis-upload-import -- tar -C /data/uploads -xf -
kubectl -n "${namespace}" exec tennis-upload-import -- find /data/uploads -type f | wc -l
echo "Upload copy finished. Run a final copy while the PM2 app is stopped before cutover."
