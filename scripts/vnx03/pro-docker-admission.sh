#!/usr/bin/env bash
# Admissions and the explicit Pro build transport, sourced by run-e2e.sh.

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

pro_build_images() {
  # Compose 5.5.1 launches standalone Buildx with DOCKER_HOST as well as
  # DOCKER_CONTEXT. Its CLI dependency can then resolve the default context.
  # Render the same build definition, but invoke Buildx through Docker with
  # an explicit global context. Keep the admitted builder and local-only output.
  "${compose[@]}" build --print --pull harness crm wordpress > "$runtime_dir/pro-bake.json" \
    || fail 'VNX03_PRO_BUILD_RENDER_FAILED'
  "$VNX03_PRO_PYTHON" -I -B -S "$repo_root/scripts/vnx03/pro-docker-admission.py" \
    bake --model "$runtime_dir/pro-bake.json" --project "$COMPOSE_PROJECT_NAME" \
    --repository "$repo_root" --package "$VNX03_PRO_PACKAGE" --head "$source_commit" \
    --tree "$source_tree" --wordpress-image "$WORDPRESS_IMAGE" \
    --connector-sha "$VNX03_CONNECTOR_SHA256" --wpforms-sha "$WPFORMS_SHA256" \
    --wp-cli-sha "$WP_CLI_SHA256" || fail 'VNX03_PRO_BUILD_MODEL_REJECTED'
  docker --context "$docker_context" buildx bake "${pro_build_arguments[@]}" \
    --file "$runtime_dir/pro-bake.json" --progress plain \
    --allow "fs.read=$repo_root" --allow "fs.read=$VNX03_PRO_PACKAGE" \
    harness crm wordpress
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
