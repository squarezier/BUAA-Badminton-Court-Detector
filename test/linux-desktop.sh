#!/usr/bin/env bash
# Run under Xvfb on a disposable Linux desktop after installing the candidate DEB.
set -euo pipefail

qa_dir=${1:?provide a new test directory}
mode=${2:?use desktop, keyring, or no-keyring}
mkdir -p "$qa_dir"
export XDG_CONFIG_HOME="$qa_dir/config" XDG_DATA_HOME="$qa_dir/share" XDG_CACHE_HOME="$qa_dir/cache"
export XDG_RUNTIME_DIR="$qa_dir/runtime" XDG_CURRENT_DESKTOP=GNOME
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
electron=(node node_modules/electron/cli.js)

case "$mode" in
  desktop)
    test "$(id -u)" != 0
    test "$(stat -c '%U:%G %a' /opt/houyu/chrome-sandbox)" = 'root:root 4755'
    desktop-file-validate /usr/share/applications/houyu.desktop
    openbox > "$qa_dir/wm.log" 2>&1 &
    wm_pid=$!
    trap 'kill "$wm_pid" 2>/dev/null || true' EXIT
    for attempt in {1..60}; do
      if xdotool getnumdesktops 2>/dev/null | grep -q '^[1-9]'; then break; fi
      sleep .2
    done
    houyu > "$qa_dir/app.log" 2>&1 &
    houyu_pid=$!
    if ! window=$(timeout 45s xdotool search --sync --onlyvisible --name '^候羽$' | head -1); then
      cat "$qa_dir/app.log"
      exit 1
    fi
    xdotool windowactivate --sync "$window"
    houyu
    kill -0 "$houyu_pid"
    xdotool key --clearmodifiers ctrl+q
    timeout 15s tail --pid="$houyu_pid" -f /dev/null
    wait "$houyu_pid"
    "${electron[@]}" test/desktop-production.cjs "$qa_dir/production"
    "${electron[@]}" test/desktop-smoke.cjs "$qa_dir/smoke"
    ;;
  keyring)
    export GNOME_KEYRING_CONTROL="$XDG_RUNTIME_DIR/keyring"
    mkdir -m 700 "$GNOME_KEYRING_CONTROL"
    dbus-update-activation-environment XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR GNOME_KEYRING_CONTROL
    printf '%s' 'isolated-fixture-password' | gnome-keyring-daemon --foreground --unlock \
      --components=secrets --control-directory="$GNOME_KEYRING_CONTROL" >"$qa_dir/keyring.log" 2>&1 &
    vault_pid=$!
    trap 'kill "$vault_pid" 2>/dev/null || true' EXIT
    gdbus wait --session --timeout 15 org.freedesktop.secrets
    gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets \
      --method org.freedesktop.Secret.Service.SetAlias default /org/freedesktop/secrets/collection/login >/dev/null
    printf '%s' 'isolated-fixture-value' | timeout 25s secret-tool store --label='Houyu test' fixture houyu-test
    test "$(secret-tool lookup fixture houyu-test)" = isolated-fixture-value
    secret-tool clear fixture houyu-test
    for action in write read; do
      timeout 60s "${electron[@]}" test/linux-keyring.cjs "$action" "$qa_dir/vault"
    done
    ;;
  no-keyring)
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/no-secret-service"
    timeout 60s "${electron[@]}" test/linux-keyring.cjs unavailable "$qa_dir/vault"
    ;;
  *) exit 2 ;;
esac
