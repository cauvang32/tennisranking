#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
namespace="${K3S_NAMESPACE:-tennis-prod}"
dump_file="${1:-}"

"${repo_root}/scripts/k3s/preflight.sh"
if [[ "${K3S_CONFIRM_DATABASE_RESTORE:-}" != "${namespace}" ]]; then
  echo "Refusing destructive target restore. Set K3S_CONFIRM_DATABASE_RESTORE=${namespace}." >&2
  exit 1
fi
if [[ -z "${dump_file}" || ! -s "${dump_file}" ]]; then
  echo "Usage: $0 /absolute/path/to/pg_dump.custom" >&2
  exit 1
fi
for command in pg_restore sha256sum; do
  command -v "${command}" >/dev/null || { echo "Missing command: ${command}" >&2; exit 1; }
done
pg_restore --list "${dump_file}" >/dev/null
echo "Import artifact SHA-256: $(sha256sum "${dump_file}" | awk '{print $1}')"

primary="$(kubectl -n "${namespace}" get cluster tennis-postgres -o jsonpath='{.status.currentPrimary}')"
if [[ -z "${primary}" ]]; then
  echo "CloudNativePG does not report a current primary." >&2
  exit 1
fi

echo "Recreating only the TARGET database 'tennis' in pod ${primary}. The source is never modified."
kubectl -n "${namespace}" exec "${primary}" -- psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'tennis' AND pid <> pg_backend_pid();"
kubectl -n "${namespace}" exec "${primary}" -- dropdb --if-exists -U postgres tennis
kubectl -n "${namespace}" exec "${primary}" -- createdb -U postgres -O tennis tennis
kubectl -n "${namespace}" exec -i "${primary}" -- pg_restore \
  -U postgres -d tennis --no-owner --no-privileges --role=tennis --exit-on-error < "${dump_file}"

kubectl -n "${namespace}" exec "${primary}" -- psql -U postgres -d tennis -Atc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
echo "Database import finished. Run the K3s migration Job next; do not start app pods yet."
