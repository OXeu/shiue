#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-}" in
  --resolve|version|env|help|completion) ;;
  server)
    if [[ "${SHIUE_IMAGES_READY:-0}" != 1 ]]; then
      node "$project_dir/scripts/deploy/identity.mjs"
      node "$project_dir/scripts/prepare-images.mjs"
      node "$project_dir/scripts/prepare-mermaid.mjs"
    fi
    ;;
  *)
    # Legacy build invocations share the deployment pipeline. Internal callers
    # that have already prepared images can still invoke the binary directly.
    if [[ "${SHIUE_IMAGES_READY:-0}" != 1 ]]; then
      exec node "$project_dir/scripts/deploy.mjs" "$@"
    fi
    ;;
esac
version="${SHIUE_HUGO_VERSION:-$(tr -d '\r\n' < "$project_dir/.hugo-version")}"

if [[ "$version" == latest ]]; then
  if [[ "${SHIUE_HUGO_OFFLINE:-0}" == 1 ]]; then
    printf '离线模式不能在线解析 latest，请使用已安装或已缓存的固定 Hugo 版本。\n' >&2
    exit 1
  fi
  release_url="$(curl --fail --silent --show-error --location --retry 2 --max-time 60 \
    --output /dev/null --write-out '%{url_effective}' \
    https://github.com/gohugoio/hugo/releases/latest)"
  version="${release_url##*/v}"
fi
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'Hugo 版本无效：%s；请设置三段版本号或 latest。\n' "$version" >&2
  exit 1
fi

run_hugo() {
  if [[ "${1:-}" == --resolve ]]; then
    printf '%s\n' "$hugo_binary"
  else
    exec "$hugo_binary" "$@"
  fi
}

if [[ -n "${HUGO_BIN:-}" && "$HUGO_BIN" != *scripts/hugo.sh ]]; then
  hugo_binary="$(command -v -- "$HUGO_BIN")"
  installed="$("$hugo_binary" version)"
  if [[ "$installed" != "hugo v${version}-"* || "$installed" != *+extended* ]]; then
    printf 'HUGO_BIN 必须指向 Hugo Extended %s，实际为：%s\n' "$version" "$installed" >&2
    exit 1
  fi
  run_hugo "$@"
  exit 0
fi

if command -v hugo >/dev/null 2>&1; then
  hugo_binary="$(command -v hugo)"
  installed="$("$hugo_binary" version)"
  if [[ "$installed" == "hugo v${version}-"* && "$installed" == *+extended* ]]; then
    run_hugo "$@"
    exit 0
  fi
fi

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  printf '自动下载仅支持 Linux x86_64；请先安装 Hugo Extended %s，再运行本脚本。\n' "$version" >&2
  exit 1
fi

cache_dir="$project_dir/.cache/deploy/hugo/$version"
hugo_binary="$cache_dir/hugo"
if [[ -x "$hugo_binary" ]]; then
  installed="$("$hugo_binary" version)"
  if [[ "$installed" == "hugo v${version}-"* && "$installed" == *+extended* ]]; then
    run_hugo "$@"
    exit 0
  fi
fi

if [[ "${SHIUE_HUGO_OFFLINE:-0}" == 1 ]]; then
  printf '离线模式缺少 Hugo Extended %s，请先联网运行一次构建或设置 HUGO_BIN。\n' "$version" >&2
  exit 1
fi
download_dir="$(mktemp -d "${TMPDIR:-/tmp}/shiue-hugo.XXXXXX")"
archive="hugo_extended_${version}_linux-amd64.tar.gz"
checksums="hugo_${version}_checksums.txt"
release="https://github.com/gohugoio/hugo/releases/download/v${version}"
printf '下载 Hugo Extended %s，并校验官方 SHA-256…\n' "$version" >&2
curl --fail --silent --show-error --location --retry 2 --max-time 120 \
  "$release/$archive" --output "$download_dir/$archive"
curl --fail --silent --show-error --location --retry 2 --max-time 60 \
  "$release/$checksums" --output "$download_dir/$checksums"
(
  cd -- "$download_dir"
  awk -v file="$archive" '$2 == file { print }' "$checksums" > selected-checksum.txt
  test -s selected-checksum.txt
  sha256sum --check selected-checksum.txt >&2
  tar -xzf "$archive" hugo
)
mkdir -p -- "$cache_dir"
mv -- "$download_dir/hugo" "$hugo_binary"
run_hugo "$@"
