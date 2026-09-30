#!/bin/sh
# Railway start. With TS_AUTHKEY set, the server first joins your Tailscale network (userspace, no special
# permissions) so Ask AI can reach a model on your own PC, e.g. FreeLLMAPI shared with `tailscale serve`. Only the
# Ask AI request goes through Tailscale (AI_PROXY); everything else connects as before. Without TS_AUTHKEY, or if
# Tailscale can't connect, the dashboard starts the same as always and Ask AI uses its built-in reader.
if [ -n "$TS_AUTHKEY" ]; then
  if command -v tailscaled >/dev/null 2>&1; then
    mkdir -p /tmp/tailscale
    # Railway drops large UDP packets on the direct path (small replies arrive, big ones stall), so traffic goes
    # through Tailscale's relays over TCP instead. TS_DIRECT=1 turns that off.
    [ "$TS_DIRECT" = "1" ] || export TS_DEBUG_ALWAYS_USE_DERP=true
    tailscaled --tun=userspace-networking --state=mem: --socket=/tmp/tailscale/sock \
      --outbound-http-proxy-listen=127.0.0.1:1055 >/tmp/tailscale/log 2>&1 &
    (
      i=0
      while [ ! -S /tmp/tailscale/sock ] && [ $i -lt 30 ]; do sleep 1; i=$((i + 1)); done
      if tailscale --socket=/tmp/tailscale/sock up --authkey="$TS_AUTHKEY" \
        --hostname="${TS_HOSTNAME:-dropship-dashboard}" --timeout=60s; then
        echo "Tailscale: connected"
        tailscale --socket=/tmp/tailscale/sock status 2>&1 | head -5
      else
        echo "Tailscale: could not connect; Ask AI will use its built-in reader. Last lines of its log:"
        tail -20 /tmp/tailscale/log
      fi
    ) &
    export AI_PROXY="${AI_PROXY:-http://127.0.0.1:1055}"
  else
    echo "Tailscale: TS_AUTHKEY is set but Tailscale isn't installed in this build; Ask AI will use its built-in reader"
  fi
fi
exec node src/server.js
