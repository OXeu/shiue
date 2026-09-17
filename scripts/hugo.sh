#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-}" in
  version|env|help|completion) ;;
  *)
    if [[ "${SHIUE_IMAGES_READY:-0}" != 1 ]]; then
      node "$project_dir/scripts/prepare-images.mjs"
    fi
    ;;
esac
version="${SHIUE_HUGO_VERSION:-$(tr -d '\r\n' < "$project_dir/.hugo-version")}"

if [[ "$version" == latest ]]; then
  release_url="$(curl --fail --silent --show-error --location --retry 2 --max-time 60 \
    --output /dev/null --write-out '%{url_effective}' \
    https://github.com/gohugoio/hugo/releases/latest)"
  version="${release_url##*/v}"
fi
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'Hugo 版本无效：%s；请设置三段版本号或 latest。\n' "$version" >&2
  exit 1
fi

if command -v hugo >/dev/null 2>&1; then
  installed="$(hugo version)"
  if [[ "$installed" == "hugo v${version}-"* && "$installed" == *+extended* ]]; then
    exec hugo "$@"
  fi
fi

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  printf '自动下载仅支持 Linux x86_64；请先安装 Hugo Extended %s，再运行本脚本。\n' "$version" >&2
  exit 1
fi

download_dir="$(mktemp -d "${TMPDIR:-/tmp}/shiue-hugo.XXXXXX")"
archive="hugo_extended_${version}_linux-amd64.tar.gz"
checksums="hugo_${version}_checksums.txt"
release="https://github.com/gohugoio/hugo/releases/download/v${version}"
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
exec "$download_dir/hugo" "$@"
