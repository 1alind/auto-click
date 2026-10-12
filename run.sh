#!/data/data/com.termux/files/usr/bin/bash

# Acquire Termux wake-lock to prevent CPU sleep during background execution
if command -v termux-wake-lock &> /dev/null; then
    termux-wake-lock &>/dev/null || true
fi

# Ensure storage access is granted for ~/storage/shared
if [ ! -d "$HOME/storage/shared" ] && command -v termux-setup-storage &> /dev/null; then
    termux-setup-storage 2>/dev/null || true
fi

# Keep npm installs completely silent unless missing node_modules
if [ ! -d "node_modules" ]; then
    echo "📦 Initializing packages (this may take a moment)..."
    npm install --legacy-peer-deps --silent &>/dev/null || npm install --legacy-peer-deps
fi

# Start local ADB server silently
adb start-server &>/dev/null || true

# Check & auto-install Wi-Fi Debug Keeper APK if connected or once device connects
APK_FILE=""
if [ -d "public/downloads" ]; then
    FOUND_APK=$(ls -t public/downloads/wifi-debug-*.apk 2>/dev/null | head -n 1 || true)
    if [ -n "$FOUND_APK" ] && [ -f "$FOUND_APK" ]; then
        APK_FILE="$FOUND_APK"
    fi
fi

if [ -z "$APK_FILE" ]; then
    if [ -f "$HOME/storage/shared/autoclick/wifi-debug-keeper.apk" ]; then
        APK_FILE="$HOME/storage/shared/autoclick/wifi-debug-keeper.apk"
    elif [ -f "/sdcard/autoclick/wifi-debug-keeper.apk" ]; then
        APK_FILE="/sdcard/autoclick/wifi-debug-keeper.apk"
    elif [ -f "public/downloads/wifi-debug-keeper.apk" ]; then
        APK_FILE="public/downloads/wifi-debug-keeper.apk"
    fi
fi

APK_PKG="com.autoclick.wifidebug"

if [ -f "$APK_FILE" ]; then
    LOCAL_VER=$(aapt dump badging "$APK_FILE" 2>/dev/null | grep -oE "versionCode='[0-9]+'" | grep -oE "[0-9]+" || echo "1")
    INSTALLED_VER=$(adb shell "dumpsys package $APK_PKG 2>/dev/null | grep -E 'versionCode=[0-9]+' | head -n 1" | grep -oE "[0-9]+" || echo "0")
    LOCAL_HASH=$(sha256sum "$APK_FILE" 2>/dev/null | awk '{print $1}' || echo "")
    HASH_FILE="data/autoclick/config/installed-apk-hash.json"
    LAST_HASH=""
    if [ -f "$HASH_FILE" ]; then
        LAST_HASH=$(grep -oE '"hash":\s*"[^"]+"' "$HASH_FILE" | cut -d'"' -f4 || true)
    fi

    NEEDS_INSTALL=0
    if [ -z "$INSTALLED_VER" ] || [ "$INSTALLED_VER" -eq 0 ] 2>/dev/null; then
        echo "📦 Auto-installing Wi-Fi Debug Keeper APK (v${LOCAL_VER}) on device..."
        NEEDS_INSTALL=1
    elif [ "$LOCAL_VER" -gt "$INSTALLED_VER" ] 2>/dev/null; then
        echo "🔄 Updating Wi-Fi Debug Keeper APK from v${INSTALLED_VER} to newer v${LOCAL_VER}..."
        NEEDS_INSTALL=1
    elif [ -n "$LOCAL_HASH" ] && [ -n "$LAST_HASH" ] && [ "$LOCAL_HASH" != "$LAST_HASH" ]; then
        echo "🔄 Detected new APK build modification — applying update..."
        NEEDS_INSTALL=1
    else
        echo "✅ Wi-Fi Debug Keeper APK up-to-date (v${INSTALLED_VER})"
    fi

    if [ "$NEEDS_INSTALL" -eq 1 ]; then
        INST_OUT=$(adb install -r -d -g "$APK_FILE" 2>&1 || true)
        if echo "$INST_OUT" | grep -qi "incompatible\|failed\|error"; then
            echo "⚠️ Existing installation signature conflict detected. Removing old app and retrying clean install..."
            adb uninstall "$APK_PKG" &>/dev/null || true
            adb install -r -d -g "$APK_FILE" &>/dev/null || adb push "$APK_FILE" /data/local/tmp/app.apk &>/dev/null && adb shell pm install -r -d -g /data/local/tmp/app.apk &>/dev/null || true
        fi
        adb shell pm grant "$APK_PKG" android.permission.WRITE_SECURE_SETTINGS &>/dev/null || true
        adb shell rm -f /data/local/tmp/app.apk &>/dev/null || true
        if [ -n "$LOCAL_HASH" ]; then
            mkdir -p "$(dirname "$HASH_FILE")"
            echo "{\"hash\": \"$LOCAL_HASH\", \"versionCode\": $LOCAL_VER}" > "$HASH_FILE" 2>/dev/null || true
        fi
    fi
fi

# 1 & 2: Send start order to Wi-Fi Debug Keeper APK
echo "📲 [1/3] Sending start order to Wi-Fi Debug Keeper APK..."

# Send start broadcast/order to APK
START_RESULT=$(adb shell "am broadcast -a com.autoclick.wifidebug.ACTION_TOGGLE_DEBUG -n ${APK_PKG}/.BootReceiver 2>/dev/null || am start-foreground-service -a com.autoclick.wifidebug.ACTION_START_AND_ENABLE -n ${APK_PKG}/.DebugService 2>/dev/null || am start -n ${APK_PKG}/.MainActivity 2>/dev/null" || true)

# 3: Verify APK response and activate port
if echo "$START_RESULT" | grep -q "result=1"; then
    echo "✅ [2/3] APK confirmed Wi-Fi Debugging activated!"
else
    echo "⚡ [2/3] APK order dispatched ($START_RESULT)"
fi

# Auto-grant permissions in case it was freshly installed
adb shell pm grant "$APK_PKG" android.permission.WRITE_SECURE_SETTINGS &>/dev/null || true

# 4: Start searching for port and connecting immediately
echo "🔍 [3/3] Searching for active wireless debug port..."

# Quick check on default 5555
adb connect 127.0.0.1:5555 &>/dev/null || true

# If not connected yet on 5555, scan dynamic ports with nmap / mDNS if available
if ! adb devices | grep -q "127.0.0.1:5555.*device"; then
    # Try mDNS port discovery
    MDNS_PORT=$(adb mdns services 2>/dev/null | grep -oE "127\.0\.0\.1:[0-9]+" | head -n 1 || true)
    if [ -n "$MDNS_PORT" ]; then
        echo "🔗 Connecting via mDNS: $MDNS_PORT..."
        adb connect "$MDNS_PORT" &>/dev/null || true
    elif command -v nmap &>/dev/null; then
        echo "🔎 Scanning local ports with nmap..."
        OPEN_PORT=$(nmap -p 5555,30000-50000 --open -T4 127.0.0.1 2>/dev/null | grep "tcp open" | awk -F'/' '{print $1}' | head -n 1 || true)
        if [ -n "$OPEN_PORT" ]; then
            echo "🔗 Found open port: 127.0.0.1:$OPEN_PORT - Connecting..."
            adb connect "127.0.0.1:$OPEN_PORT" &>/dev/null || true
        fi
    fi
fi

# Display connected devices status
CONNECTED_DEV=$(adb devices | grep -E "127\.0\.0\.1|localhost" | grep "device" | head -n 1 || true)
if [ -n "$CONNECTED_DEV" ]; then
    echo "🚀 Connected to device: $CONNECTED_DEV"
else
    echo "⏳ Port search continuing in background supervisor..."
fi

# Start the Supervisor Runner
npx tsx runner.ts
