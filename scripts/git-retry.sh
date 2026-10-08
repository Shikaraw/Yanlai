#!/usr/bin/env bash
# Robust git-over-SSH wrapper for an unreliable network.
#
# Measured on this machine: connections to GitHub are intermittent — roughly
# 60% of `git ls-remote` attempts are killed with "Connection reset", while a
# failed attempt retries cleanly a moment later. SSH auth itself always succeeds
# when the TCP connection survives.
#
# Strategy: try port 443 first (survives more firewalls), fall back to port 22,
# and retry the whole operation up to N times with a short backoff.
#
# Usage:  scripts/git-retry.sh <git args...>
#   e.g.  scripts/git-retry.sh push -u origin main

set -uo pipefail

ATTEMPTS="${GIT_RETRY_ATTEMPTS:-12}"
BACKOFF="${GIT_RETRY_BACKOFF:-4}"

# Hosts to try in order. 443 first: it is the more reliable path here.
HOSTS=(
  "ssh.github.com:443"
  "github.com:22"
)

attempt=0
while [ "$attempt" -lt "$ATTEMPTS" ]; do
  attempt=$((attempt + 1))
  host="${HOSTS[$(( (attempt - 1) % ${#HOSTS[@]} ))]}"
  hname="${host%%:*}"
  hport="${host##*:}"

  echo "[git-retry] 第 ${attempt}/${ATTEMPTS} 次 · ${hname}:${hport} · git $*" >&2

  if GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -o ServerAliveInterval=20 -o ServerAliveCountMax=10 -p ${hport}" \
     git "$@" 2>&1; then
    echo "[git-retry] ✓ 成功（第 ${attempt} 次尝试）" >&2
    exit 0
  else
    echo "[git-retry] ✗ 本次失败，${BACKOFF}s 后重试…" >&2
    sleep "$BACKOFF"
  fi
done

echo "[git-retry] 放弃：${ATTEMPTS} 次尝试均失败。可能是网络完全中断，或需要开启 FlClash 节点。" >&2
exit 1
