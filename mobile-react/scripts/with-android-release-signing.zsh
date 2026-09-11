#!/bin/zsh

set -euo pipefail

if (( $# == 0 )); then
  print -u2 'Usage: scripts/with-android-release-signing.zsh <command> [args...]'
  exit 64
fi

typeset -r keychain_service='com.zhengyiluo.agentsdock.android-signing'
typeset -r keychain_account='release-keystore'
typeset -r keystore_path="${AGENTSDOCK_ANDROID_KEYSTORE_PATH:-}"

if [[ -z "$keystore_path" || "$keystore_path" != /* ]]; then
  print -u2 'Set AGENTSDOCK_ANDROID_KEYSTORE_PATH to the absolute path of your local keystore.'
  exit 64
fi

if [[ ! -f "$keystore_path" ]]; then
  print -u2 "Android release keystore is missing: $keystore_path"
  exit 66
fi

typeset signing_password
signing_password="$(security find-generic-password \
  -s "$keychain_service" \
  -a "$keychain_account" \
  -w)"

export AGENTSDOCK_ANDROID_KEYSTORE_PATH="$keystore_path"
export AGENTSDOCK_ANDROID_KEYSTORE_PASSWORD="$signing_password"
export AGENTSDOCK_ANDROID_KEY_ALIAS='agentsdock-release'
export AGENTSDOCK_ANDROID_KEY_PASSWORD="$signing_password"

"$@"
