#!/data/data/com.termux/files/usr/bin/bash

# Acquire Termux wake-lock to prevent CPU sleep during background execution
if command -v termux-wake-lock &> /dev/null; then
    termux-wake-lock &>/dev/null || true
fi

# Ensure storage access is granted for ~/storage/shared
if [ ! -d "$HOME/storage/shared" ] && command -v termux-setup-storage &> /dev/null; then
    termux-setup-storage 2>/dev/null || true
fi

# Auto-enable Wireless Debugging & ADB TCP/IP if Shizuku / root is available
echo "📡 [Startup] Checking auto-enable for Wireless Debugging..."
if command -v rish &>/dev/null; then
    echo "📡 [Startup] Trying Method 1: Shizuku (rish in PATH)..."
    export RISH_APPLICATION_ID="com.termux"
    rish -c "settings put global adb_wifi_enabled 1; settings put global adb_enabled 1; setprop service.adb.tcp.port 5555; stop adbd; start adbd" 2>/dev/null && echo "📡 [Startup] ✅ Shizuku enabled!" || echo "📡 [Startup] ❌ Shizuku (rish) failed"
elif [ -f "$HOME/rish" ]; then
    echo "📡 [Startup] Trying Method 1: Shizuku (~/rish)..."
    export RISH_APPLICATION_ID="com.termux"
    "$HOME/rish" -c "settings put global adb_wifi_enabled 1; settings put global adb_enabled 1; setprop service.adb.tcp.port 5555; stop adbd; start adbd" 2>/dev/null && echo "📡 [Startup] ✅ Shizuku enabled!" || echo "📡 [Startup] ❌ Shizuku (~/rish) failed"
elif command -v su &>/dev/null; then
    echo "📡 [Startup] Trying Method 2: Root (su)..."
    su -c "settings put global adb_wifi_enabled 1; settings put global adb_enabled 1; setprop service.adb.tcp.port 5555; stop adbd; start adbd" 2>/dev/null && echo "📡 [Startup] ✅ Root enabled!" || echo "📡 [Startup] ❌ Root (su) failed"
else
    echo "📡 [Startup] Trying Method 3: Direct settings binary..."
    settings put global adb_wifi_enabled 1 2>/dev/null && echo "📡 [Startup] ✅ Settings put succeeded!" || echo "📡 [Startup] ❌ Settings put failed (unprivileged)"
fi

# Keep npm installs completely silent unless missing node_modules
if [ ! -d "node_modules" ]; then
    echo "📦 Initializing packages (this may take a moment)..."
    npm install --legacy-peer-deps --silent &>/dev/null || npm install --legacy-peer-deps
fi

# Start local ADB server silently
adb start-server &>/dev/null || true

# Start the Supervisor Runner
npx tsx runner.ts
