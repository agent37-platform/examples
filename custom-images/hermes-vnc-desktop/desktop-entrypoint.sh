#!/bin/bash
set -euo pipefail

# Chromium's profile lives on the persisted home volume, so a login done during a
# takeover survives restarts and sleep.
PROFILE_DIR="${HOME}/.config/desktop-chromium"

# Absolute paths throughout: the image PATH puts the persisted home first, so a
# `pip install websockify` in ~/.venv would otherwise replace the one we run.
respawn() {
  local log="$1"
  shift
  while true; do
    "$@" >"${log}" 2>&1 || true
    sleep 2
  done
}

# The last run's profile lock can name a pid that is alive again after a restart,
# and Chromium then refuses the profile, so drop it first. Chromium's own sandbox
# cannot start under gVisor; --test-type only hides the warning bar about that.
run_chromium() {
  rm -f "${PROFILE_DIR}"/Singleton{Lock,Socket,Cookie}
  /usr/bin/chromium --no-sandbox --test-type --disable-dev-shm-usage \
    --no-first-run --no-default-browser-check --hide-crash-restore-bubble \
    --remote-debugging-port=9222 --user-data-dir="${PROFILE_DIR}" \
    --start-maximized about:blank
}

# The stock entrypoint starts Xvfb on :99 and openbox. Wait for the display, then
# attach the VNC stack and the Chromium the agent drives:
#   x11vnc     screencasts :99 on loopback port 5900
#   websockify serves the noVNC web client on 6901 and bridges it to 5900
#   chromium   runs headed on the display, DevTools open on loopback 9222 for Hermes
# Each one comes back if it exits, so closing the browser during a takeover reopens it.
start_desktop_view() {
  (
    export DISPLAY=:99
    until /usr/bin/xdpyinfo >/dev/null 2>&1; do sleep 1; done

    respawn /tmp/x11vnc.log /usr/bin/x11vnc -display :99 -rfbport 5900 -localhost \
      -forever -shared -nopw -quiet &
    respawn /tmp/novnc.log /usr/bin/websockify --web /usr/share/novnc 6901 localhost:5900 &
    respawn /tmp/chromium.log run_chromium &
    wait
  ) &
}

# /tmp survives a restart, and Xvfb refuses to start while the last boot's lock
# names a pid that happens to be alive again.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

start_desktop_view

# The stock entrypoint does everything else: managed model, Composio, Brave, paid tools,
# the agent37 CLI's skill, hooks, and the gateway on 3737.
exec /usr/local/bin/entrypoint.sh "$@"
