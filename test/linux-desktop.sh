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
    stage='wait for Openbox'
    finish_desktop() {
      local status=$?
      if ((status != 0)); then
        printf 'Ubuntu desktop failed at "%s" (rc=%s, elapsed=%ss)\n' "$stage" "$status" "$SECONDS" >&2
        xprop -root _NET_ACTIVE_WINDOW _NET_CLIENT_LIST _NET_SUPPORTING_WM_CHECK >&2 || true
        if [[ -n ${houyu_pid:-} ]]; then
          ps -o pid,stat,comm -p "$houyu_pid" >&2 || true
          kill "$houyu_pid" 2>/dev/null || true
        fi
      fi
      kill "$wm_pid" 2>/dev/null || true
    }
    trap finish_desktop EXIT
    wait_until() {
      local deadline=$((SECONDS + $1))
      shift
      until "$@"; do
        if ((SECONDS >= deadline)); then return 1; fi
        sleep .1
      done
    }
    wm_ready() { [[ $(xdotool get_num_desktops 2>/dev/null) =~ ^[1-9][0-9]*$ ]]; }
    find_window() { xdotool search --all --onlyvisible --limit 1 --pid "$houyu_pid" --name '^候羽$'; }
    visible() { window=$(find_window) && [[ -n $window ]]; }
    hidden() { ! find_window >/dev/null; }
    focused() {
      [[ $(xdotool getactivewindow 2>/dev/null) == "$original" && $(xdotool getwindowfocus 2>/dev/null) == "$original" ]]
    }
    wait_until 12 wm_ready
    stage='show the original application window'
    houyu > "$qa_dir/app.log" 2>&1 &
    houyu_pid=$!
    wait_until 45 visible
    original=$window
    for cycle in 1 2; do
      stage="focus the application before closing ($cycle)"
      timeout 10s xdotool windowactivate --sync "$original"
      wait_until 10 focused
      stage="hide the application with Alt+F4 ($cycle)"
      xdotool key --clearmodifiers alt+F4
      wait_until 10 hidden
      kill -0 "$houyu_pid"
      stage="launch the second instance ($cycle)"
      timeout 15s houyu
      stage="recover the original window ($cycle)"
      wait_until 15 visible
      test "$window" = "$original"
    done
    stage='wait for keyboard focus after restoring the window'
    timeout 10s xdotool windowactivate --sync "$original"
    wait_until 10 focused
    stage='quit through the Ctrl+Q accelerator'
    xdotool key --clearmodifiers ctrl+q
    timeout 15s tail --pid="$houyu_pid" -f /dev/null
    wait "$houyu_pid"
    unset houyu_pid
    stage='desktop production regression'
    "${electron[@]}" test/desktop-production.cjs "$qa_dir/production"
    stage='renderer and timetable regression'
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
