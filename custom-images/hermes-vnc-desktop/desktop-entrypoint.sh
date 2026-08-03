#!/usr/bin/env bash
set -euo pipefail

# Wire Hermes to the platform's managed LLM endpoint (see
# https://www.agent37.com/docs/agents-api/managed-services). hermes-base is a clean
# image, so nothing does this for us. Runs on EVERY boot because the token is
# reissued on create/start/restart/update; a config written once would 401 after
# the first restart. Merges into ~/.hermes/config.yaml, preserving your other keys.
configure_managed_llm() {
  [ -n "${AGENT37_LLM_PROXY_URL:-}" ] && [ -n "${AGENT37_MANAGED_TOKEN:-}" ] || return 0
  "${HERMES_PYTHON:-python3}" - <<'PY' || echo "managed LLM config failed; chat will need manual credentials" >&2
import os, yaml

path = os.path.expanduser("~/.hermes/config.yaml")
os.makedirs(os.path.dirname(path), exist_ok=True)
try:
    with open(path) as f:
        cfg = yaml.safe_load(f) or {}
except FileNotFoundError:
    cfg = {}

base = os.environ["AGENT37_LLM_PROXY_URL"].rstrip("/")
if not base.endswith("/v1"):
    base += "/v1"

providers = [p for p in cfg.get("custom_providers", []) if not (isinstance(p, dict) and p.get("name") == "Agent37")]
providers.append({
    "name": "Agent37",
    "base_url": base,
    "api_key": os.environ["AGENT37_MANAGED_TOKEN"],
    "api_mode": "chat_completions",
    "model": "default",
})
cfg["custom_providers"] = providers

model = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
if not (model.get("default") or model.get("model")):
    model["default"] = "default"
model["provider"] = "custom:Agent37"
cfg["model"] = model

with open(path, "w") as f:
    yaml.safe_dump(cfg, f)
PY
}

# The hermes-base entrypoint starts Xvfb on :99 and openbox. Wait for the display,
# then attach the VNC stack and the Chromium the agent drives:
#   x11vnc     screencasts :99 on loopback port 5900
#   websockify serves the noVNC web client on 6901 and bridges it to 5900
#   chromium   runs headed on the display, DevTools open on loopback 9222 for Hermes
start_desktop_view() {
  (
    export DISPLAY=:99
    until xdpyinfo >/dev/null 2>&1; do sleep 1; done

    x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -nopw -quiet \
      >/tmp/x11vnc.log 2>&1 &
    websockify --web /usr/share/novnc 6901 localhost:5900 >/tmp/novnc.log 2>&1 &

    chromium --no-sandbox --disable-dev-shm-usage \
      --no-first-run --no-default-browser-check \
      --remote-debugging-port=9222 \
      --user-data-dir="$HOME/.config/chromium" \
      --start-maximized about:blank >/tmp/chromium.log 2>&1 &
  ) &
}

configure_managed_llm
start_desktop_view

exec /usr/local/bin/entrypoint.sh
