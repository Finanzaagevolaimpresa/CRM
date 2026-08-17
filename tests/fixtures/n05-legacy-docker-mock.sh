# Synthetic Docker inventory for N05 legacy resource identity unit tests.
# It never calls a Docker daemon and contains no production data.

docker() {
  local command="${1:-}" mode="${2:-}" arguments="$*" template resource
  case "$command" in
    ps)
      if [[ "$mode" == "-q" ]]; then
        return 0
      fi
      [[ "$mode" == "-aq" ]] || return 1
      case "$arguments" in
        *com.docker.compose.service=app*) printf 'app-id\n' ;;
        *com.docker.compose.service=postgres*) printf 'postgres-id\n' ;;
        *) printf 'app-id\npostgres-id\n' ;;
      esac
      ;;
    inspect)
      [[ "$mode" == "-f" ]] || return 1
      template="$3"
      resource="$4"
      case "$template" in
        '{{.Name}}')
          [[ "$resource" == "app-id" ]] && printf '/fai-crm-app-1\n' || printf '/fai-crm-postgres-1\n'
          ;;
        '{{.Config.Image}}')
          [[ "$resource" == "app-id" ]] && printf '%s\n' "$APP_IMAGE" || printf '%s\n' "$POSTGRES_IMAGE"
          ;;
        '{{.Image}}') printf '%s\n' "$EXPECTED_APP_IMAGE_ID" ;;
        *'/var/lib/fai-crm/documents'*) printf 'fai-crm_crm_documents\n' ;;
        *'/var/lib/postgresql/data'*) printf 'fai-crm_postgres_data\n' ;;
        *'com.docker.compose.project'*) printf 'fai-crm\n' ;;
        *'com.docker.compose.service'*)
          [[ "$resource" == "app-id" ]] && printf 'app\n' || printf 'postgres\n'
          ;;
        *'it.finanzaagevolaimpresa.environment'*) n05_mock_environment_label "$resource" ;;
        *'it.finanzaagevolaimpresa.sentinel'*) n05_mock_sentinel_label "$resource" ;;
        *) return 1 ;;
      esac
      ;;
    volume)
      case "$mode" in
        ls) printf 'fai-crm_crm_documents\nfai-crm_postgres_data\n' ;;
        inspect)
          template="$4"
          resource="$5"
          case "$template" in
            '{{.Driver}}') printf 'local\n' ;;
            '{{.Scope}}') printf 'local\n' ;;
            *'com.docker.compose.project'*) printf 'fai-crm\n' ;;
            *'com.docker.compose.volume'*)
              if [[ "$resource" == "fai-crm_crm_documents" ]]; then
                [[ "${TAMPER_VOLUME_LOGICAL:-0}" == "1" ]] && printf 'forged\n' || printf 'crm_documents\n'
              else
                printf 'postgres_data\n'
              fi
              ;;
            *'it.finanzaagevolaimpresa.environment'*) n05_mock_environment_label "$resource" ;;
            *'it.finanzaagevolaimpresa.sentinel'*) n05_mock_sentinel_label "$resource" ;;
            *) return 1 ;;
          esac
          ;;
        *) return 1 ;;
      esac
      ;;
    network)
      case "$mode" in
        ls) printf 'network-id\n' ;;
        inspect)
          template="$4"
          resource="$5"
          [[ "$resource" == "network-id" ]] || return 1
          case "$template" in
            '{{.Name}}') printf 'fai-crm_default\n' ;;
            '{{.Driver}}') printf 'bridge\n' ;;
            '{{.Scope}}') printf 'local\n' ;;
            *'com.docker.compose.project'*) printf 'fai-crm\n' ;;
            *'com.docker.compose.network'*) printf 'default\n' ;;
            *'it.finanzaagevolaimpresa.environment'*) n05_mock_environment_label "$resource" ;;
            *'it.finanzaagevolaimpresa.sentinel'*) n05_mock_sentinel_label "$resource" ;;
            *) return 1 ;;
          esac
          ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

n05_mock_environment_label() {
  local resource="$1"
  case "${LABEL_MODE:-legacy}" in
    all-labeled) printf 'production\n' ;;
    containers-labeled)
      [[ "$resource" == "app-id" || "$resource" == "postgres-id" ]] && printf 'production\n' || printf '<no value>\n'
      ;;
    partial)
      [[ "$resource" == "postgres-id" ]] && printf 'production\n' || printf '<no value>\n'
      ;;
    *) printf '<no value>\n' ;;
  esac
}

n05_mock_sentinel_label() {
  local resource="$1"
  case "${LABEL_MODE:-legacy}" in
    all-labeled) printf 'FAI_CRM_PRODUCTION_V1\n' ;;
    containers-labeled)
      [[ "$resource" == "app-id" || "$resource" == "postgres-id" ]] \
        && printf 'FAI_CRM_PRODUCTION_V1\n' || printf '<no value>\n'
      ;;
    partial) printf '<no value>\n' ;;
    *) printf '<no value>\n' ;;
  esac
}
