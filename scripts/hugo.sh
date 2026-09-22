#!/usr/bin/env bash
# Hugo Extended 的定位与下载脚本。
#
# 查找顺序：HUGO_BIN 环境变量 → PATH 中的 hugo → .cache 缓存 → 在线下载。
# 每个候选都必须匹配 .hugo-version 且为 extended 版本，否则继续下一个来源。
# 仅在线下载：Linux x86_64；下载后以官方 SHA-256 校验。

set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# 部署流水线已完成资源准备（SHIUE_IMAGES_READY=1）时直接透传给 Hugo；
# 否则旧式调用（如 IDE 集成）先走完整部署入口。
# server / version / env / help / completion 子命令无需准备，直接透传。
case "${1:-}" in
  --resolve|version|env|help|completion) ;;
  server)
    if [[ "${SHIUE_IMAGES_READY:-0}" != 1 ]]; then
      node "$project_dir/scripts/assets/identity.mjs"
      node "$project_dir/scripts/assets/images.mjs"
      node "$project_dir/scripts/assets/d2.mjs"
    fi
    ;;
  *)
    if [[ "${SHIUE_IMAGES_READY:-0}" != 1 ]]; then
      exec node "$project_dir/scripts/deploy.mjs" "$@"
    fi
    ;;
esac

# 版本优先级：环境变量 SHIUE_HUGO_VERSION → .hugo-version 文件；latest 需在线解析。
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

# 候选一：HUGO_BIN 指定的二进制（跳过 hugo.sh 自身，避免递归）。
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

# 候选二：PATH 中的 hugo，版本匹配则直接使用。
if command -v hugo >/dev/null 2>&1; then
  hugo_binary="$(command -v hugo)"
  installed="$("$hugo_binary" version)"
  if [[ "$installed" == "hugo v${version}-"* && "$installed" == *+extended* ]]; then
    run_hugo "$@"
    exit 0
  fi
fi

# 候选三之前：自动下载仅支持 Linux x86_64。
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  printf '自动下载仅支持 Linux x86_64；请先安装 Hugo Extended %s，再运行本脚本。\n' "$version" >&2
  exit 1
fi

# 候选三：本仓库缓存中的同名版本。
cache_dir="$project_dir/.cache/deploy/hugo/$version"
hugo_binary="$cache_dir/hugo"
if [[ -x "$hugo_binary" ]]; then
  installed="$("$hugo_binary" version)"
  if [[ "$installed" == "hugo v${version}-"* && "$installed" == *+extended* ]]; then
    run_hugo "$@"
    exit 0
  fi
fi

# 候选四：从 GitHub Releases 下载并校验。
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
  # 从总校验文件中取出对应条目，确认存在后本地校验。
  awk -v file="$archive" '$2 == file { print }' "$checksums" > selected-checksum.txt
  test -s selected-checksum.txt
  sha256sum --check selected-checksum.txt >&2
  tar -xzf "$archive" hugo
)
mkdir -p -- "$cache_dir"
mv -- "$download_dir/hugo" "$hugo_binary"
run_hugo "$@"
