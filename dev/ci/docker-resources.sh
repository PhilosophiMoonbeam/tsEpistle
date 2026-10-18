#!/usr/bin/env bash
# Sourced by CI wrappers. Unset controls preserve their existing execution defaults.

ci_fill_docker_resources() {
  local -n result=$1
  local memory=$2
  local cpus=$3
  result=()
  if [[ -n "$memory" ]]; then
    if [[ ! "$memory" =~ ^[1-9][0-9]*[kKmMgG]?$ ]]; then
      echo 'CI Docker memory must be a positive byte count or k/m/g quantity.' >&2
      return 1
    fi
    result+=(--memory "$memory" --memory-swap "$memory")
  fi
  if [[ -n "$cpus" ]]; then
    if [[ ! "$cpus" =~ ^[1-9][0-9]*$ ]]; then
      echo 'CI Docker CPUs must be a positive integer.' >&2
      return 1
    fi
    result+=(--cpus "$cpus")
  fi
}

ci_app_docker_args=()
ci_postgres_docker_args=()
ci_fill_docker_resources ci_app_docker_args "${WIKI_CI_APP_MEMORY:-}" "${WIKI_CI_APP_CPUS:-}" || return 1
ci_fill_docker_resources ci_postgres_docker_args "${WIKI_CI_POSTGRES_MEMORY:-}" "${WIKI_CI_POSTGRES_CPUS:-}" || return 1
