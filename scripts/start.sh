#!/bin/sh
# Railway start. With TS_AUTHKEY set, the server first joins your Tailscale network (userspace, no special
# permissions) so Ask AI can reach a model on your own PC, e.g. FreeLLMAPI shared with `tailscale serve`. Only the
# Ask AI request goes through Tailscale (AI_PROXY); everything else connects as before. Without TS_AUTHKEY, or if
# Tailscale can't connect, the dashboard starts the same as always and Ask AI uses its built-in reader.
if [ -n "$TS_AUTHKEY" ]; then
  if command -v tailscaled >/dev/null 2>&1; then
    mkdir -p /tmp/tailscale
    tailscaled --tun=userspace-networking --state=mem: --socket=/tmp/tailscale/sock \
      --outbound-http-proxy-listen=127.0.0.1:1055 >/tmp/tailscale/log 2>&1 &
    (
      i=0
      while [ ! -S /tmp/tailscale/sock ] && [ $i -lt 30 ]; do sleep 1; i=$((i + 1)); done
      if tailscale --socket=/tmp/tailscale/sock up --authkey="$TS_AUTHKEY" \
        --hostname="${TS_HOSTNAME:-dropship-dashboard}" --timeout=60s; then
        echo "Tailscale: connected"
      else
        echo "Tailscale: could not connect (see /tmp/tailscale/log); Ask AI will use its built-in reader"
      fi
    ) &
    export AI_PROXY="${AI_PROXY:-http://127.0.0.1:1055}"
  else
    echo "Tailscale: TS_AUTHKEY is set but Tailscale isn't installed in this build; Ask AI will use its built-in reader"
  fi
fi
exec node src/server.js
