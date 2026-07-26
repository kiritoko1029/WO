#!/bin/sh

set -eu

if [ "$#" -ne 4 ]; then
  printf '%s\n' 'Build metadata requires exactly four values' >&2
  exit 1
fi

build_created=$1
build_revision=$2
build_version=$3
source_date_epoch=$4

if ! printf '%s\n' "$build_created" |
  grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
  printf '%s\n' 'BUILD_CREATED must be a canonical UTC timestamp' >&2
  exit 1
fi
if ! printf '%s\n' "$build_revision" | grep -Eq '^[a-f0-9]{40}$'; then
  printf '%s\n' 'BUILD_REVISION must be a full lowercase Git commit' >&2
  exit 1
fi
case "$source_date_epoch" in
  '' | 0 | *[!0-9]*)
    printf '%s\n' 'SOURCE_DATE_EPOCH must be a positive integer' >&2
    exit 1
    ;;
esac

if [ "$build_version" = 'integration' ]; then
  if [ "$build_created" != '1970-01-01T00:00:01Z' ] ||
    [ "$build_revision" != '0000000000000000000000000000000000000000' ] ||
    [ "$source_date_epoch" != '1' ]; then
    printf '%s\n' 'Integration build metadata must use the fixed sentinel' >&2
    exit 1
  fi
  exit 0
fi

if [ "$build_revision" = '0000000000000000000000000000000000000000' ]; then
  printf '%s\n' 'Production BUILD_REVISION cannot use the integration sentinel' >&2
  exit 1
fi

expected_created=$(
  date -u -d "@$source_date_epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null
) || {
  printf '%s\n' 'SOURCE_DATE_EPOCH cannot be converted to UTC' >&2
  exit 1
}
if [ "$build_created" != "$expected_created" ]; then
  printf '%s\n' 'BUILD_CREATED and SOURCE_DATE_EPOCH must describe one instant' >&2
  exit 1
fi

version_date=$(printf '%s' "$build_created" | cut -c 1-10 | tr '-' '.')
version_revision=$(printf '%s' "$build_revision" | cut -c 1-12)
if [ "$build_version" != "$version_date-$version_revision" ]; then
  printf '%s\n' 'BUILD_VERSION must be derived from the commit date and SHA' >&2
  exit 1
fi
