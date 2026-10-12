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

# 1 & 2: Send start order to Wi-Fi Debug Keeper APK
echo "📲 [1/3] Sending start order to Wi-Fi Debug Keeper APK..."
APK_PKG="com.autoclick.wifidebug"

# Send start broadcast/order to APK
START_RESULT=$(adb shell "am broadcast -a com.autoclick.wifidebug.ACTION_TOGGLE_DEBUG -n ${APK_PKG}/.BootReceiver 2>/dev/null || am start-foreground-service -a com.autoclick.wifidebug.ACTION_START_AND_ENABLE -n ${APK_PKG}/.DebugService 2>/dev/null || am start -n ${APK_PKG}/.MainActivity 2>/dev/null" || true)

# 3: Verify APK response and activate port
if echo "$START_RESULT" | grep -q "result=1"; then
    echo "✅ [2/3] APK confirmed Wi-Fi Debugging activated!"
else
    echo "⚡ [2/3] APK order dispatched ($START_RESULT)"
fi

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
