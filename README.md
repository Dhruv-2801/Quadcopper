#!/bin/bash

URL="http://127.0.0.1:8080"

# Wait until the dashboard is responding
until curl --silent --fail "$URL/api/health" >/dev/null 2>&1; do
    sleep 2
done

# Prevent an old Chromium warning window
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' \
    "$HOME/.config/chromium/Default/Preferences" 2>/dev/null || true

chromium \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --no-first-run \
    "$URL"
