#!/usr/bin/env bash
# Method selection is not human execution authority. Previous plans/grants do
# not authorize this proposed build/runtime contract.
pro_require_network_contract() {
  [[ "${VNX03_PRO_NETWORK_CONTRACT:-}" == 'build-boundary-v1' ]] \
    || fail 'VNX03_PRO_NEW_NETWORK_CONTRACT_REQUIRED'
}

pro_build_before_runtime() {
  local baseline_sha
  local boundary=("$VNX03_PRO_PYTHON" -I -B -S "$repo_root/scripts/vnx03/pro-network-boundary.py")
  local binding=(--directory "$evidence_dir/pro-network-boundary"
    --contract "$VNX03_PRO_NETWORK_CONTRACT" --context "$docker_context"
    --engine "$VNX03_EXPECTED_DOCKER_ENGINE_ID" --endpoint "$docker_endpoint"
    --head "$source_commit" --tree "$source_tree" --project "$COMPOSE_PROJECT_NAME")
  pro_require_network_contract
  baseline_sha="$("${boundary[@]}" prepare "${binding[@]}")" \
    || fail 'VNX03_PRO_NETWORK_BASELINE_DENIED'
  [[ "$baseline_sha" =~ ^[0-9a-f]{64}$ ]] || fail 'VNX03_PRO_NETWORK_BASELINE_INVALID'
  # Baseline failure must not enable resource cleanup. Build may create only
  # the previously admitted project images, so enable cleanup immediately here.
  compose_resources_created=true
  pro_build_images || fail 'VNX03_PRO_IMAGE_BUILD_FAILED'
  "${boundary[@]}" admit "${binding[@]}" --baseline-sha "$baseline_sha" \
    || fail 'VNX03_PRO_POST_BUILD_BOUNDARY_DENIED'
}
