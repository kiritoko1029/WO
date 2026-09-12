#!/bin/sh
set -eu

# Slim images have no CA bundle yet. Debian's archive signatures and package
# hashes remain mandatory when bootstrapping over HTTP; never trust a mirror key.
mode=${WO_APT_SOURCE:-mirrors}
sources=/etc/apt/sources.list.d/debian.sources
[ "$#" -gt 0 ] || { echo 'No Debian packages requested' >&2; exit 64; }

install_packages() {
  # apt-get update otherwise succeeds even when one index could not be fetched.
  timeout 120 apt-get \
    -o Acquire::Retries=1 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 \
    -o APT::Update::Error-Mode=any "$@" update \
  && timeout 600 apt-get \
    -o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 \
    install -y --no-install-recommends $packages
}

# Package names are fixed Dockerfile arguments, not shell fragments.
packages=
for package in "$@"; do
  case "$package" in ''|*[!a-z0-9+.-]*) echo 'Invalid Debian package name' >&2; exit 64 ;; esac
  packages="$packages $package"
done

case "$mode" in
  snapshot)
    # Keep the base image's exact archive timestamp for release reproducibility.
    grep -q '^# http://snapshot.debian.org/archive/' "$sources" || {
      echo 'Pinned Debian snapshot metadata is missing from the base image' >&2; exit 1;
    }
    sed -i \
      -e 's|^# http://snapshot.debian.org/|URIs: http://snapshot.debian.org/|' \
      -e '/^URIs: http:\/\/deb.debian.org\//d' "$sources"
    rm -rf /var/lib/apt/lists/*
    install_packages -o Acquire::Check-Valid-Until=false || {
      echo 'Pinned Debian snapshot failed; release builds do not switch package sources' >&2; exit 1;
    }
    ;;
  mirrors)
    installed=false
    for mirror in http://mirrors.ustc.edu.cn http://mirrors.tuna.tsinghua.edu.cn http://deb.debian.org; do
      printf 'Debian package source: %s\n' "$mirror"
      printf '%s\n' \
        'Types: deb' "URIs: $mirror/debian" \
        'Suites: bookworm bookworm-updates' 'Components: main' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' '' \
        'Types: deb' "URIs: $mirror/debian-security" \
        'Suites: bookworm-security' 'Components: main' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' > "$sources"
      # Never reuse a partial index from the previous candidate.
      rm -rf /var/lib/apt/lists/*
      if install_packages; then installed=true; break; fi
      printf 'Debian source failed: %s; trying the next source\n' "$mirror" >&2
    done
    [ "$installed" = true ] || {
      echo 'All Debian package sources failed; check outbound DNS and HTTP connectivity' >&2; exit 1;
    }
    ;;
  *) echo 'WO_APT_SOURCE must be mirrors or snapshot' >&2; exit 64 ;;
esac
rm -rf /var/lib/apt/lists/*
