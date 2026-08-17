#!/usr/bin/env bash
set -Eeuo pipefail

mode="${K3S_MODE:-ha}"
manifest="${1:?Usage: render-manifest.sh MANIFEST [IMAGE]}"
image="${2:-}"

if [[ "${mode}" != "ha" && "${mode}" != "single" ]]; then
  echo "K3S_MODE must be 'single' or 'ha', got: ${mode}" >&2
  exit 1
fi
if [[ ! -f "${manifest}" ]]; then
  echo "Manifest not found: ${manifest}" >&2
  exit 1
fi

case "$(basename "${manifest}")" in
  postgres.yaml)
    if [[ "${mode}" == "single" ]]; then
      sed \
        -e 's/^  instances: 3$/  instances: 1/' \
        -e 's/^  primaryUpdateMethod: switchover$/  primaryUpdateMethod: restart/' \
        -e '/^  minSyncReplicas:/d' \
        -e '/^  maxSyncReplicas:/d' \
        "${manifest}"
    else
      cat "${manifest}"
    fi
    ;;
  redis.yaml)
    if [[ "${mode}" == "single" ]]; then
      sed 's/^  clusterSize: 3$/  clusterSize: 1/' "${manifest}"
    else
      cat "${manifest}"
    fi
    ;;
  app.yaml)
    if [[ -z "${image}" ]]; then
      echo "An immutable image is required to render ${manifest}" >&2
      exit 1
    fi
    if [[ "${mode}" == "single" ]]; then
      sed \
        -e 's/^  replicas: 3$/  replicas: 1/' \
        -e 's/^  minAvailable: 2$/  minAvailable: 1/' \
        -e "s|registry.example.invalid/tennis-ranking:replace-me|${image}|g" \
        "${manifest}"
    else
      sed "s|registry.example.invalid/tennis-ranking:replace-me|${image}|g" "${manifest}"
    fi
    ;;
  fcm-worker.yaml)
    if [[ -z "${image}" ]]; then
      echo "An immutable image is required to render ${manifest}" >&2
      exit 1
    fi
    if [[ "${mode}" == "single" ]]; then
      sed \
        -e 's/^  replicas: 2$/  replicas: 1/' \
        -e "s|registry.example.invalid/tennis-ranking:replace-me|${image}|g" \
        "${manifest}"
    else
      sed "s|registry.example.invalid/tennis-ranking:replace-me|${image}|g" "${manifest}"
    fi
    ;;
  *)
    cat "${manifest}"
    ;;
esac
