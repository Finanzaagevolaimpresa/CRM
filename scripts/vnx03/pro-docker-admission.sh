#!/usr/bin/env bash
# Read-only admissions sourced by run-e2e.sh; no build/lifecycle/cleanup here.

pro_bind_builder() {
  local setting builder_info
  for setting in BUILDX_BUILDER BUILDKIT_HOST DOCKER_BUILDKIT COMPOSE_DOCKER_CLI_BUILD COMPOSE_BAKE; do
    [[ -z "${!setting:-}" ]] || fail 'VNX03_PRO_BUILD_OVERRIDE_FORBIDDEN'
  done
  builder_info="$(docker --context "$docker_context" buildx inspect "$docker_context")" \
    || fail 'VNX03_PRO_BUILDER_INSPECTION_FAILED'
  printf '%s\n' "$builder_info" | "$VNX03_PRO_PYTHON" -I -B -S \
    "$repo_root/scripts/vnx03/pro-docker-admission.py" builder --context "$docker_context" \
    || fail 'VNX03_PRO_BUILDER_REJECTED'
  # Explicit selection ignores a different persistent/default Buildx builder.
  # The docker driver is the Engine-integrated builder of this exact context.
  pro_build_arguments=(--builder "$docker_context")
}

pro_require_resource_names_absent() {
  "${compose[@]}" --profile n14 config --format json > "$runtime_dir/pro-model.json" \
    || fail 'VNX03_PRO_MODEL_READ_FAILED'
  docker volume ls --format '{{.Name}}' > "$runtime_dir/pro-volume-names" \
    || fail 'VNX03_PRO_RESOURCE_INVENTORY_FAILED'
  docker network ls --format '{{.Name}}' > "$runtime_dir/pro-network-names" \
    || fail 'VNX03_PRO_RESOURCE_INVENTORY_FAILED'
  docker ps -a --format '{{.Names}}' > "$runtime_dir/pro-container-names" \
    || fail 'VNX03_PRO_RESOURCE_INVENTORY_FAILED'
  "$VNX03_PRO_PYTHON" -I -B -S "$repo_root/scripts/vnx03/pro-docker-admission.py" \
    resources --project "$COMPOSE_PROJECT_NAME" --model "$runtime_dir/pro-model.json" \
    --volumes "$runtime_dir/pro-volume-names" --networks "$runtime_dir/pro-network-names" \
    --containers "$runtime_dir/pro-container-names" \
    || fail 'VNX03_PRO_RESOURCE_NAME_COLLISION_OR_INVALID_METADATA'
}
