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

# Start the Supervisor Runner
npx tsx runner.ts
