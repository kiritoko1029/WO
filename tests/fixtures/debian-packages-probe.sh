#!/bin/sh
set -eu
mkdir -p /probe-bin
cp /etc/apt/sources.list.d/debian.sources /original.sources
cat > /probe-bin/apt-get <<'SH'
#!/bin/sh
set -eu
source=$(sed -n 's/^URIs: //p' /etc/apt/sources.list.d/debian.sources | head -1)
operation=install
case " $* " in *' update '*) operation=update ;; esac
printf '%s %s\n' "$source" "$operation" >> /calls
case " $* " in *'Acquire::http::Timeout=20'*) ;; *) exit 90 ;; esac
if [ "$operation" = update ]; then
  case " $* " in *'APT::Update::Error-Mode=any'*) ;; *) exit 91 ;; esac
  [ ! -e /var/lib/apt/lists/partial-sentinel ] || exit 92
  case "${PROBE_MODE}:$source" in
    all-fail:*|index-fail:*ustc*|snapshot-fail:*)
      touch /var/lib/apt/lists/partial-sentinel
      exit 100 ;;
  esac
else
  case " $* " in *'--no-install-recommends build-essential libssl-dev'*) ;; *) exit 93 ;; esac
  case "${PROBE_MODE}:$source" in install-fail:*ustc*) exit 100 ;; esac
fi
SH
chmod +x /probe-bin/apt-get
export PATH="/probe-bin:$PATH"

for PROBE_MODE in index-fail install-fail; do
  export PROBE_MODE
  : > /calls
  WO_APT_SOURCE=mirrors sh /installer.sh build-essential libssl-dev
  grep -q 'http://mirrors.tuna.tsinghua.edu.cn/debian install' /calls
  if [ "$PROBE_MODE" = index-fail ]; then
    ! grep -q 'http://mirrors.ustc.edu.cn/debian install' /calls
  fi
  [ ! -e /var/lib/apt/lists/partial-sentinel ]
done
echo MIRROR_FAILURE_RECOVERY_OK

export PROBE_MODE=all-fail
: > /calls
if WO_APT_SOURCE=mirrors sh /installer.sh build-essential libssl-dev; then exit 1; fi
[ "$(wc -l < /calls)" -eq 3 ]
! grep -q ' install$' /calls
echo INCOMPLETE_INDEX_REJECTED_OK

cp /original.sources /etc/apt/sources.list.d/debian.sources
export PROBE_MODE=snapshot-fail
: > /calls
if WO_APT_SOURCE=snapshot sh /installer.sh build-essential libssl-dev; then exit 1; fi
[ "$(wc -l < /calls)" -eq 1 ]
grep -q 'snapshot.debian.org' /calls
! grep -q 'mirrors.' /calls
echo SNAPSHOT_FAILS_WITHOUT_MUTABLE_FALLBACK_OK

cp /original.sources /etc/apt/sources.list.d/debian.sources
export PROBE_MODE=success
: > /calls
WO_APT_SOURCE=snapshot sh /installer.sh build-essential libssl-dev
grep -q 'snapshot.debian.org.* install' /calls
echo SNAPSHOT_INSTALL_OK
