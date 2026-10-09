#!/usr/bin/env bash
# Sourced by run-e2e.sh. Selecting a profile is not runtime authorization.
# Pro bytes stay local; no account URL, license or credential is accepted.

case "${VNX03_WPFORMS_EDITION:-lite}" in
  lite)
    WPFORMS_EDITION='lite'
    WPFORMS_SLUG='wpforms-lite'
    WPFORMS_VERSION='2.0.1.1'
    WPFORMS_URL='https://downloads.wordpress.org/plugin/wpforms-lite.2.0.1.1.zip'
    WPFORMS_SHA256='6245074790df01a6e24a42587e024132b4a28fac499d1a8fa12ebf5580e4852b'
    WPFORMS_SOURCE='downloads.wordpress.org'
    WORDPRESS_VERSION='7.1'
    WORDPRESS_IMAGE='wordpress:7.1-php8.4-apache@sha256:b8f37de278183840a09f5a4b5bf5ec9f09177a9984d2fe5cc072b4388128bd9d'
    EXPECTED_PHP_VERSION=''
    ;;
  pro)
    WPFORMS_EDITION='pro'
    WPFORMS_SLUG='wpforms'
    WPFORMS_VERSION='2.0.2.2'
    WPFORMS_URL=''
    WPFORMS_SHA256='0e3fba8ed7388c816790ff5580984cdf599b638d92d64f6ffd5ffc2a1b200db2'
    WPFORMS_SOURCE='local-official-account-package'
    WORDPRESS_VERSION='7.1.3'
    WORDPRESS_IMAGE='wordpress:7.1.3-php8.4-apache@sha256:c74a0947d65b4cf20071d4324e2ac6a80db015451934716ad61f93fe471122ce'
    EXPECTED_PHP_VERSION='8.4.26'
    [[ -n "${VNX03_PRO_PACKAGE:-}" && -f "$VNX03_PRO_PACKAGE" && ! -L "$VNX03_PRO_PACKAGE" ]] \
      || fail 'VNX03_PRO_PACKAGE_REQUIRED'
    [[ -n "${VNX03_PRO_PYTHON:-}" && -f "$VNX03_PRO_PYTHON" ]] \
      || fail 'VNX03_PRO_PYTHON_REQUIRED'
    [[ -n "${VNX03_EXPECTED_DOCKER_ENGINE_ID:-}" && -n "${VNX03_EXPECTED_DOCKER_CONTEXT:-}" ]] \
      || fail 'VNX03_PRO_LOCAL_ENGINE_BINDING_REQUIRED'
    [[ -z "${DOCKER_HOST:-}" ]] || fail 'VNX03_PRO_DOCKER_HOST_OVERRIDE_FORBIDDEN'
    [[ "${VNX03_QUALIFICATION_PROFILE:-}" == 'candidate-schema49' ]] \
      || fail 'VNX03_PRO_SCHEMA49_REQUIRED'
    "$VNX03_PRO_PYTHON" -I -B -S "$repo_root/scripts/vnx03/inspect-wpforms-pro-package.py" \
      "$VNX03_PRO_PACKAGE" --expected-version "$WPFORMS_VERSION" \
      --expected-sha256 "$WPFORMS_SHA256" --outside-directory "$repo_root" >/dev/null \
      || fail 'VNX03_PRO_PACKAGE_ADMISSION_FAILED'
    ;;
  *) fail 'VNX03_WPFORMS_EDITION_INVALID' ;;
esac
readonly WPFORMS_EDITION WPFORMS_SLUG WPFORMS_VERSION WPFORMS_URL WPFORMS_SHA256
readonly WPFORMS_SOURCE WORDPRESS_VERSION WORDPRESS_IMAGE EXPECTED_PHP_VERSION
