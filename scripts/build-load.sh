#!/usr/bin/env bash
# builds all 4 service images and loads them into the kind cluster.
# usage: ./scripts/build-load.sh [tag]   # tag defaults to "ci"
# requires: docker, kind, kind cluster named "aura" already created

set -euo pipefail

TAG="${1:-ci}"
CLUSTER="${KIND_CLUSTER:-aura}"

echo "==> building images with tag :${TAG}"
docker build -t "aura-api-gateway:${TAG}"   ./backend/api-gateway
docker build -t "aura-pg-service:${TAG}"    ./backend/inventory-order-service
docker build -t "aura-mongo-service:${TAG}" ./backend/catalog-analytics-service
docker build -t "aura-frontend:${TAG}"      ./frontend

echo "==> loading images into kind cluster '${CLUSTER}'"
kind load docker-image \
    "aura-api-gateway:${TAG}" \
    "aura-pg-service:${TAG}" \
    "aura-mongo-service:${TAG}" \
    "aura-frontend:${TAG}" \
    --name "${CLUSTER}"

echo "==> done. images are now available to kubelet inside the cluster."
echo "    next step: helm upgrade --install aura ./helm/aura \\"
echo "                 -f helm/aura/values-dev.yaml \\"
echo "                 --set image.registry=docker.io/library \\"
echo "                 --set image.tag=${TAG} \\"
echo "                 --create-namespace --namespace aura --wait --timeout 8m"
