# Wi-Fi Debug Keeper (Auto-Reconnect APK & Dashboard Hub)

A lightweight Android utility APK (`com.autoclick.wifidebug`) designed for non-rooted Samsung Galaxy devices (A50 / A52s) that automatically enables Wireless Debugging and restores TCP port `5555` upon device reboot or Wi-Fi network reconnects, paired with a web download portal and Discord bot commands.

## User Review & Critical Decisions

> [!IMPORTANT]
> Based on your confirmed choices:
> - **Target Devices**: Samsung Galaxy A50 (Android 10/11) and Galaxy A52s (Android 12/13/14), non-rooted.
> - **Mode**: Standard Port 5555 (`adb connect <ip>:5555`) with automatic toggle fallback for Android 11+ Wireless Debugging.
> - **Delivery**: Direct APK download served from the dashboard with an interactive 1-time setup guide and Discord download link.
> - **Permission Model**: 1-time ADB permission grant via PC or bot (`WRITE_SECURE_SETTINGS`), after which the APK runs fully autonomously without ever needing a USB connection again.

---

## 1. Overview & Core Concept

When Samsung Galaxy devices restart or temporarily disconnect from Wi-Fi, the Android operating system automatically turns off ADB over TCP/IP and resets the debug port from `5555` to `-1`. 

**Wi-Fi Debug Keeper** solves this permanently:
1. **Boot Receiver (`BOOT_COMPLETED`)**: Fires immediately after the phone powers on, re-enables Wi-Fi debugging, and launches the persistent service.
2. **Network Callback (`NetworkCallback` / Wi-Fi State)**: Detects when Wi-Fi drops and reconnects (e.g. router reboot or leaving/returning to home network), re-initiating the TCP port and updating current device IP.
3. **Persistent Foreground Service**: Runs a battery-friendly foreground notification displaying the current status (`Wi-Fi Debugging: Active on 192.168.1.X:5555`) to prevent Samsung One UI battery killer from terminating it.
4. **Dashboard & Discord Portal**: The web dashboard provides a direct 1-click APK download, step-by-step setup walkthrough, and a Discord command (`!apk` / `!wifidebug`) to retrieve the APK download link and copyable permission commands directly in chat.

---

## 2. User Experience & Visual Design

### A. Web Dashboard "Wi-Fi Debug Keeper" Hub
Following the SaaS Dashboard design guidelines (`3_saas_dashboard.md`):
- **Compact Action Card**: A clean, single-elevation card (`border border-neutral-800 bg-neutral-900/60 rounded-xl p-5`) dedicated to device connectivity.
- **Direct Download**: Prominent single-line button: `Download Wi-Fi Debug Keeper (.apk)` with version badge and file size.
- **1-Time Setup Walkthrough**:
  - Step 1: Install APK on Samsung Galaxy A50 / A52s.
  - Step 2: Open app once and copy the 1-time permission grant command:
    ```bash
    adb shell pm grant com.autoclick.wifidebug android.permission.WRITE_SECURE_SETTINGS
    ```
  - Step 3: Verify green active indicator. Device is now self-healing on reboots and Wi-Fi disconnects.
- **One-Click Command Copier**: Interactive button to instantly copy the `pm grant` command to clipboard with toast confirmation.

### B. Discord Bot Command Integration
- **`apk` / `wifidebug` Command**:
  Typing `apk` or `wifidebug` in Discord replies with:
  - Direct download URL from the server (`https://.../api/download/wifi-debug-keeper.apk`).
  - Copyable 1-time permission grant command.
  - Quick summary of features.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Native Android APK with `WRITE_SECURE_SETTINGS` vs. Root / Shizuku**
  - *Chosen Approach*: Lightweight APK requiring only a single one-time ADB permission grant (`WRITE_SECURE_SETTINGS`).
  - *Why*: User confirmed devices are non-rooted. `WRITE_SECURE_SETTINGS` allows Android apps to modify `Settings.Global.putInt(contentResolver, "adb_wifi_enabled", 1)` and control debugging parameters programmatically without root.
  - *Alternative Considered*: Requiring Shizuku adds a complex multi-step pairing layer that itself gets lost after reboot on older Android versions.

- **Decision 2: Foreground Service with Notification vs. Periodic Alarms**
  - *Chosen Approach*: Sticky foreground service with a low-priority notification showing current IP/port.
  - *Why*: Samsung One UI (especially on Galaxy A50 and A52s) aggressively terminates background receivers after 10-15 minutes of screen-off unless running an ongoing service or exempt from battery optimization.

---

## 4. Technical Architecture & Data Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                 Samsung Galaxy Device (A50/A52s)            │
│                                                             │
│   ┌─────────────────┐           ┌──────────────────────┐    │
│   │ Device Reboot   │           │ Wi-Fi Reconnect /    │    │
│   │ (BOOT_COMPLETED)│           │ NetworkCallback      │    │
│   └────────┬────────┘           └──────────┬───────────┘    │
│            │                               │                │
│            ▼                               ▼                │
│     ┌──────────────────────────────────────────────┐        │
│     │   WifiDebugReceiver & Sticky Foreground Svc  │        │
│     └──────────────────────┬───────────────────────┘        │
│                            │                                │
│                            ▼                                │
│     ┌──────────────────────────────────────────────┐        │
│     │  Settings.Global (adb_wifi_enabled = 1)      │        │
│     │  Activate port 5555 / Read Wi-Fi Local IP    │        │
│     └──────────────────────┬───────────────────────┘        │
│                            │                                │
│                            ▼                                │
│     ┌──────────────────────────────────────────────┐        │
│     │ Status Notification: 192.168.1.X:5555 Active │        │
│     └──────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────┘
                             ▲
                             │ 1. Download & Install APK
                             │ 2. One-time "pm grant" command
┌────────────────────────────┴────────────────────────────────┐
│               Applet Server & Web Dashboard                 │
│                                                             │
│   ┌───────────────────────────┐ ┌───────────────────────┐   │
│   │ GET /api/download/        │ │ Discord Command:      │   │
│   │ wifi-debug-keeper.apk     │ │ apk / wifidebug       │   │
│   └───────────────────────────┘ └───────────────────────┘   │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ Dashboard UI: APK Download Card & Setup Guide       │   │
│   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Proposed Deliverables:
1. **`WifiDebugKeeper.apk`**:
   - Ready-to-install standalone signed Android APK file hosted directly in the app at `/public/downloads/wifi-debug-keeper.apk`.
   - Complete manifest configured with `RECEIVE_BOOT_COMPLETED`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `FOREGROUND_SERVICE`, and `WRITE_SECURE_SETTINGS`.
2. **Server Download Endpoint**:
   - `/api/download/wifi-debug-keeper.apk` route streaming the binary with proper `application/vnd.android.package-archive` MIME type and Content-Disposition headers.
3. **Discord Bot Commands**:
   - `apkCommand` / `wifiDebugCommand` added to Discord bot so typing `apk` or `wifidebug` in Discord immediately provides the download link and instructions.
4. **Web Dashboard Setup Widget**:
   - Clean, professional card in the React management UI with 1-click download, copyable permission command, and connection validator.
