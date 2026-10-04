import { exec, execFile } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
}

export interface TapResult {
  x: number;
  y: number;
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
  command: string;
  success: boolean;
  output?: string;
  isSimulated?: boolean;
}

export class AdbController {
  private serial: string = '';
  private host: string = '';
  private autoConnectStopped = false;
  private isAutoConnecting = false;
  private autoConnectWaiters: Array<(serial: string) => void> = [];
  private tapChain: Promise<any> = Promise.resolve();
  private lastTapFinishedAt: number = 0;
  private lastTapCoords: { x: number; y: number } | null = null;

  constructor(options?: { serial?: string; host?: string }) {
    if (options?.serial) this.serial = AdbController.normalizeHost(options.serial);
    if (options?.host) this.host = AdbController.normalizeHost(options.host);
  }

  public stopAutoConnect(): boolean {
    const wasRunning = this.isAutoConnecting;
    this.autoConnectStopped = true;
    this.isAutoConnecting = false;
    const waiters = [...this.autoConnectWaiters];
    this.autoConnectWaiters = [];
    for (const resolve of waiters) resolve('');
    return wasRunning;
  }

  public isAutoConnectRunning(): boolean {
    return this.isAutoConnecting;
  }

  /**
   * Uses nmap to scan 127.0.0.1 ports 30000-50000 for open Wireless Debugging ports and connects automatically.
   */
  public async scanWithNmapAndConnect(): Promise<string> {
    try {
      await execPromise('adb start-server').catch(() => {});
      const { stdout } = await execPromise('nmap -p 30000-50000 --open -T4 127.0.0.1');
      const openPorts: string[] = [];
      const regex = /(\d{5})\/tcp\s+open/gi;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(stdout)) !== null) {
        openPorts.push(match[1]);
      }

      for (const port of openPorts) {
        const target = `127.0.0.1:${port}`;
        const { stdout: connOut, stderr: connErr } = await execPromise(`adb connect ${target}`).catch((e) => ({
          stdout: e.stdout || '',
          stderr: e.stderr || e.message || ''
        }));
        const out = `${connOut} ${connErr}`.toLowerCase();
        if (
          (out.includes('connected to') || out.includes('already connected')) &&
          !out.includes('unable') &&
          !out.includes('failed') &&
          !out.includes('cannot') &&
          !out.includes('refused')
        ) {
          const devices = await this.getDevices();
          const isOnline = devices.some((d) => d.serial === target && d.state === 'device');
          if (isOnline) {
            this.serial = target;
            this.host = target;
            return target;
          }
        }
      }
    } catch {
      // nmap or adb error
    }
    return '';
  }

  /**
   * Starts a continuous background watcher on startup so the script automatically finds the port
   * via nmap (127.0.0.1:30000-50000) without waiting for a `connect` command.
   * Sends the "no port" message to Discord ONLY ONCE per disconnect and keeps trying every 10s in background
   * unless `stop` is sent.
   */
  public startBackgroundAutoConnect(): void {
    if (this.isAutoConnecting) return;
    this.autoConnectWithRetry().catch(() => {});
  }

  /**
   * Scans 127.0.0.1:30000-50000 with nmap and connects automatically.
   * Always sends "connected to 127.0.0.1:<port>" in Discord when connected.
   * If it fails, sends a Discord message ONCE and keeps retrying silently in the background every 10 seconds
   * until connected or `stop` is sent.
   */
  public async autoConnectWithRetry(): Promise<string> {
    const { botManager } = await import('./botManager');
    const webhook = botManager.getWebhookService();

    const sendOnce = async (text: string) => {
      if (!webhook.isConfigured()) return;
      try {
        await webhook.send({ content: text });
      } catch {
        // ignore webhook error
      }
    };

    // First try immediate nmap scan
    const immediate = await this.scanWithNmapAndConnect();
    if (immediate) {
      botManager.updateConfig({ adbHost: immediate, adbSerial: immediate });
      await sendOnce(`connected to ${immediate}`);
      return immediate;
    }

    if (this.isAutoConnecting) {
      return await new Promise<string>((resolve) => this.autoConnectWaiters.push(resolve));
    }

    this.isAutoConnecting = true;
    this.autoConnectStopped = false;

    // Send failure message ONLY ONCE to Discord, then keep retrying silently in background every 10s
    await sendOnce('no open port found in 127.0.0.1:30000-50000 — retrying every 10s in background (send `stop` to stop)');

    while (!this.autoConnectStopped) {
      await new Promise((r) => setTimeout(r, 10000));
      if (this.autoConnectStopped) break;

      const found = await this.scanWithNmapAndConnect();
      if (found) {
        this.isAutoConnecting = false;
        botManager.updateConfig({ adbHost: found, adbSerial: found });
        await sendOnce(`connected to ${found}`);
        const waiters = [...this.autoConnectWaiters];
        this.autoConnectWaiters = [];
        for (const resolve of waiters) resolve(found);
        return found;
      }
    }

    this.isAutoConnecting = false;
    await sendOnce('stopped adb auto-connect');
    const waiters = [...this.autoConnectWaiters];
    this.autoConnectWaiters = [];
    for (const resolve of waiters) resolve('');
    return '';
  }

  public setSerial(serial: string): void {
    this.serial = serial ? AdbController.normalizeHost(serial) : '';
  }

  public setHost(host: string): void {
    this.host = host ? AdbController.normalizeHost(host) : '';
  }

  /**
   * Checks if running inside Termux on Android.
   */
  public static isTermux(): boolean {
    return Boolean(
      process.env.TERMUX_VERSION ||
      process.env.PREFIX?.includes('com.termux') ||
      process.env.HOME?.includes('com.termux')
    );
  }

  private adbAvailableCache: boolean | null = null;

  /**
   * Checks if ADB is installed and available in PATH.
   */
  public async isAdbAvailable(): Promise<boolean> {
    if (this.adbAvailableCache === true) return true;
    try {
      await execPromise('adb version');
      this.adbAvailableCache = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Discovers connected Android devices via `adb devices -l`.
   */
  public async getDevices(): Promise<AdbDevice[]> {
    const devices: AdbDevice[] = [];
    const isAdb = await this.isAdbAvailable();

    if (!isAdb) {
      throw new Error('ADB command not found in environment PATH. Please make sure adb/android-tools is installed.');
    }

    const { stdout } = await execPromise('adb devices -l');
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      if (line.startsWith('List of devices attached') || line.startsWith('*')) {
        continue;
      }
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const serial = parts[0];
        const state = parts[1];
        const modelMatch = line.match(/model:(\S+)/);
        const model = modelMatch ? modelMatch[1].replace(/_/g, ' ') : undefined;

        devices.push({
          serial,
          state,
          model
        });
      }
    }

    return devices;
  }

  /**
   * Normalizes any port or host:port input to always use 127.0.0.1:<port>.
   */
  public static normalizeHost(rawHost: string): string {
    const clean = rawHost.trim();
    const portMatch = clean.match(/(?:^|:)(\d{2,5})$/);
    if (portMatch) {
      return `127.0.0.1:${portMatch[1]}`;
    }
    return clean;
  }

  /**
   * Resolves the best -s 127.0.0.1:<port> flag by verifying the device is online,
   * auto-switching if a new 127.0.0.1:<port> is connected, or reconnecting if dropped.
   */
  private async resolveTargetFlag(forceRefresh = false): Promise<string> {
    if (this.serial && !forceRefresh) {
      this.serial = AdbController.normalizeHost(this.serial);
      return `-s ${this.serial}`;
    }

    try {
      let devices = await this.getDevices();
      let online = devices.filter((d) => d.state === 'device');
      let localOnline = online.filter((d) => d.serial.startsWith('127.0.0.1:'));

      // If our current 127.0.0.1:<port> serial is still online, keep it
      if (this.serial && localOnline.some((d) => d.serial === this.serial)) {
        return `-s ${this.serial}`;
      }

      // If another 127.0.0.1:<port> wireless debugging port is online, switch to it automatically
      if (localOnline.length >= 1) {
        this.serial = localOnline[0].serial;
        this.host = localOnline[0].serial;
        return `-s ${this.serial}`;
      }

      // If any other device with a port is online, normalize it to 127.0.0.1:<port> and connect
      const withPort = devices.find((d) => d.serial.includes(':'));
      if (withPort) {
        const localTarget = AdbController.normalizeHost(withPort.serial);
        await execPromise(`adb connect ${localTarget}`).catch(() => {});
        devices = await this.getDevices();
        localOnline = devices.filter((d) => d.state === 'device' && d.serial.startsWith('127.0.0.1:'));
        if (localOnline.length >= 1) {
          this.serial = localOnline[0].serial;
          this.host = localOnline[0].serial;
          return `-s ${this.serial}`;
        }
      }

      // Otherwise, if we had a known host/serial, force 127.0.0.1:<port> and try reconnecting it
      const lastHost = AdbController.normalizeHost(this.host || this.serial);
      if (lastHost && lastHost.startsWith('127.0.0.1:')) {
        await execPromise(`adb connect ${lastHost}`).catch(() => {});
        devices = await this.getDevices();
        localOnline = devices.filter((d) => d.state === 'device' && d.serial.startsWith('127.0.0.1:'));
        if (localOnline.length >= 1) {
          this.serial = localOnline[0].serial;
          this.host = localOnline[0].serial;
          return `-s ${this.serial}`;
        }
      }

      // Use nmap on 127.0.0.1 (ports 30000-40000) to find the port and auto-connect (retrying every 10s until connected or stopped)
      const autoConnected = await this.autoConnectWithRetry();
      if (autoConnected) {
        return `-s ${autoConnected}`;
      }
    } catch {
      // ignore
    }

    this.serial = '';
    return '';
  }

  /**
   * Pairs with ADB over Wireless Debugging (`adb pair <ip:port> <code>`).
   */
  public async pair(targetHost: string, code: string): Promise<{ success: boolean; message: string }> {
    const isAdb = await this.isAdbAvailable();
    if (!isAdb) {
      return { success: false, message: 'adb not found in PATH' };
    }

    const host = AdbController.normalizeHost(targetHost);
    const cleanCode = code.trim();

    try {
      await execPromise('adb start-server').catch(() => {});
      const { stdout, stderr } = await execPromise(`adb pair ${host} ${cleanCode}`);
      const output = `${stdout} ${stderr}`.trim();
      const success = output.toLowerCase().includes('successfully paired');
      return { success, message: output || (success ? `paired ${host}` : 'pair failed') };
    } catch (err: any) {
      return { success: false, message: err.message || 'pair failed' };
    }
  }

  /**
   * Connects to ADB over TCP/IP (Wireless debugging).
   */
  public async connectTcp(targetHost: string): Promise<{ success: boolean; message: string }> {
    const isAdb = await this.isAdbAvailable();
    if (!isAdb) {
      return { success: false, message: 'adb not found in PATH' };
    }

    const host = AdbController.normalizeHost(targetHost);

    try {
      await execPromise('adb start-server').catch(() => {});
      const { stdout, stderr } = await execPromise(`adb connect ${host}`);
      const output = `${stdout} ${stderr}`.trim();
      const lower = output.toLowerCase();
      const success =
        (lower.includes('connected to') || lower.includes('already connected')) &&
        !lower.includes('unable to connect') &&
        !lower.includes('failed to connect') &&
        !lower.includes('cannot connect');

      if (success) {
        this.host = host;
        this.serial = host;
      }
      return { success, message: output || (success ? `connected to ${host}` : 'connect failed') };
    } catch (err: any) {
      return { success: false, message: err.message || 'connect failed' };
    }
  }

  /**
   * Taps an exact coordinate (X, Y) via standard ADB shell.
   * Serializes all touch commands and enforces a settle gap so Android never coalesces two taps into a swipe.
   */
  public async tap(x: number, y: number): Promise<TapResult> {
    const runTap = async (): Promise<TapResult> => {
      const roundedX = Math.round(x);
      const roundedY = Math.round(y);
      const isAdb = await this.isAdbAvailable();
      if (!isAdb) {
        throw new Error('ADB is not available. Connect a real Android device.');
      }

      // Ensure previous touch ACTION_UP has completely settled on Android before injecting a new ACTION_DOWN
      const elapsedSinceLastTap = Date.now() - this.lastTapFinishedAt;
      if (elapsedSinceLastTap < 150) {
        await new Promise((r) => setTimeout(r, 150 - elapsedSinceLastTap));
      }

      let adbTarget = await this.resolveTargetFlag();
      const clickCmd = `adb ${adbTarget} shell input touchscreen tap ${roundedX} ${roundedY}`;
      const removeAllCmd = `adb ${adbTarget} shell "input motionevent UP ${roundedX} ${roundedY} >/dev/null 2>&1; input motionevent CANCEL 0 0 >/dev/null 2>&1"`;

      try {
        // 1. adb click
        const { stdout } = await execPromise(clickCmd);
        // 2. adb remove all touches on screen
        await execPromise(removeAllCmd).catch(() => {});

        this.lastTapFinishedAt = Date.now();
        this.lastTapCoords = { x: roundedX, y: roundedY };
        return {
          x: roundedX,
          y: roundedY,
          command: `${clickCmd} && ${removeAllCmd}`,
          success: true,
          output: stdout.trim()
        };
      } catch (err: any) {
        await execPromise(removeAllCmd).catch(() => {});

        // Refresh target device and retry once in case Wireless Debugging port changed or reconnected
        adbTarget = await this.resolveTargetFlag(true);
        if (!adbTarget) {
          throw new Error('no adb device connected (run: connect <port>)');
        }
        const retryClickCmd = `adb ${adbTarget} shell input touchscreen tap ${roundedX} ${roundedY}`;
        const retryRemoveAllCmd = `adb ${adbTarget} shell "input motionevent UP ${roundedX} ${roundedY} >/dev/null 2>&1; input motionevent CANCEL 0 0 >/dev/null 2>&1"`;

        const { stdout } = await execPromise(retryClickCmd);
        await execPromise(retryRemoveAllCmd).catch(() => {});

        this.lastTapFinishedAt = Date.now();
        this.lastTapCoords = { x: roundedX, y: roundedY };
        return {
          x: roundedX,
          y: roundedY,
          command: `${retryClickCmd} && ${retryRemoveAllCmd}`,
          success: true,
          output: stdout.trim()
        };
      }
    };

    const next = this.tapChain.then(runTap, runTap);
    this.tapChain = next.catch(() => {});
    return next;
  }

  /**
   * Taps a uniformly randomized point within specified bounding intervals [minX..maxX], [minY..maxY].
   */
  public async tapRandomRange(minX: number, maxX: number, minY: number, maxY: number): Promise<TapResult> {
    const lowX = Math.min(minX, maxX);
    const highX = Math.max(minX, maxX);
    const lowY = Math.min(minY, maxY);
    const highY = Math.max(minY, maxY);

    const randomX = Math.floor(lowX + Math.random() * (highX - lowX + 1));
    const randomY = Math.floor(lowY + Math.random() * (highY - lowY + 1));

    const result = await this.tap(randomX, randomY);
    return {
      ...result,
      minX: lowX,
      maxX: highX,
      minY: lowY,
      maxY: highY
    };
  }

  /**
   * Swipes from (x1, y1) to (x2, y2) over durationMs via standard ADB shell.
   * Serialized through tapChain and cleans up any lingering touch state after completion.
   */
  public async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs = 300
  ): Promise<{ success: boolean; command: string; output: string }> {
    const runSwipe = async () => {
      const rx1 = Math.round(x1);
      const ry1 = Math.round(y1);
      const rx2 = Math.round(x2);
      const ry2 = Math.round(y2);
      const dur = Math.max(80, Math.round(durationMs));

      const isAdb = await this.isAdbAvailable();
      if (!isAdb) {
        throw new Error('ADB is not available. Connect a real Android device.');
      }

      const elapsedSinceLastTap = Date.now() - this.lastTapFinishedAt;
      if (elapsedSinceLastTap < 120) {
        await new Promise((r) => setTimeout(r, 120 - elapsedSinceLastTap));
      }

      let adbTarget = await this.resolveTargetFlag();
      const swipeCmd = `adb ${adbTarget} shell input swipe ${rx1} ${ry1} ${rx2} ${ry2} ${dur}`;

      try {
        const { stdout } = await execPromise(swipeCmd);
        this.lastTapFinishedAt = Date.now();
        return {
          success: true,
          command: swipeCmd,
          output: stdout.trim()
        };
      } catch {
        adbTarget = await this.resolveTargetFlag(true);
        if (!adbTarget) {
          throw new Error('no adb device connected (run: connect <port>)');
        }
        const retrySwipeCmd = `adb ${adbTarget} shell input swipe ${rx1} ${ry1} ${rx2} ${ry2} ${dur}`;
        const { stdout } = await execPromise(retrySwipeCmd);
        this.lastTapFinishedAt = Date.now();
        return {
          success: true,
          command: retrySwipeCmd,
          output: stdout.trim()
        };
      }
    };

    const next = this.tapChain.then(runSwipe, runSwipe);
    this.tapChain = next.catch(() => {});
    return next;
  }

  /**
   * Sends an Android keyevent (e.g., 4 = BACK, 3 = HOME, 187 = APP_SWITCH).
   */
  public async keyEvent(keyCode: number | string): Promise<{ success: boolean; output: string }> {
    const isAdb = await this.isAdbAvailable();
    if (!isAdb) {
      throw new Error('ADB is not available.');
    }
    let adbTarget = await this.resolveTargetFlag();
    try {
      const { stdout } = await execPromise(`adb ${adbTarget} shell input keyevent ${keyCode}`);
      return { success: true, output: stdout.trim() };
    } catch {
      adbTarget = await this.resolveTargetFlag(true);
      const { stdout } = await execPromise(`adb ${adbTarget} shell input keyevent ${keyCode}`);
      return { success: true, output: stdout.trim() };
    }
  }

  /**
   * Inputs text via ADB shell input text.
   */
  public async inputText(text: string): Promise<{ success: boolean; output: string }> {
    const isAdb = await this.isAdbAvailable();
    if (!isAdb) {
      throw new Error('ADB is not available.');
    }
    const escaped = String(text)
      .replace(/ /g, '%s')
      .replace(/["'`$\\;&|<>(){}[\]!#*?~]/g, '\\$&');
    let adbTarget = await this.resolveTargetFlag();
    try {
      const { stdout } = await execPromise(`adb ${adbTarget} shell input text "${escaped}"`);
      return { success: true, output: stdout.trim() };
    } catch {
      adbTarget = await this.resolveTargetFlag(true);
      const { stdout } = await execPromise(`adb ${adbTarget} shell input text "${escaped}"`);
      return { success: true, output: stdout.trim() };
    }
  }

  /**
   * Gets the physical screen resolution via `adb shell wm size`.
   * Defaults to 1080x2400 if unavailable.
   */
  public async getScreenSize(): Promise<{ width: number; height: number }> {
    try {
      const isAdb = await this.isAdbAvailable();
      if (isAdb) {
        let adbTarget = await this.resolveTargetFlag();
        let stdout = '';
        try {
          const res = await execPromise(`adb ${adbTarget} shell wm size`);
          stdout = res.stdout;
        } catch {
          adbTarget = await this.resolveTargetFlag(true);
          const res = await execPromise(`adb ${adbTarget} shell wm size`);
          stdout = res.stdout;
        }
        const match = stdout.match(/(?:Override|Physical) size:\s*(\d+)x(\d+)/i);
        if (match) {
          const w = parseInt(match[1], 10);
          const h = parseInt(match[2], 10);
          if (w > 0 && h > 0) return { width: w, height: h };
        }
      }
    } catch {
      // fallback
    }
    return { width: 1080, height: 2400 };
  }

  /**
   * Captures a fresh screen buffer using a unique Date.now() temp file in os.tmpdir()
   * and deletes it immediately after reading.
   */
  private screencapChain: Promise<any> = Promise.resolve();

  /**
   * Captures a fresh PNG screen buffer in memory via `adb exec-out screencap -p`.
   */
  public async screencap(): Promise<Buffer> {
    const isAdb = await this.isAdbAvailable();

    if (!isAdb) {
      throw new Error('ADB is not available in environment PATH. Failed to capture screen.');
    }

    let adbTarget = await this.resolveTargetFlag();
    const buildPngArgs = (targetFlag: string) => {
      const parts = targetFlag.trim().split(/\s+/).filter(Boolean);
      return [...parts, 'exec-out', 'screencap', '-p'];
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await execFilePromise('adb', buildPngArgs(adbTarget), {
          encoding: 'buffer',
          maxBuffer: 25 * 1024 * 1024
        });
        const buf = res.stdout as unknown as Buffer;
        // Verify valid PNG signature (89 50 4E 47) and IEND trailer
        if (
          buf &&
          buf.length > 500 &&
          buf[0] === 0x89 &&
          buf[1] === 0x50 &&
          buf[2] === 0x4e &&
          buf[3] === 0x47
        ) {
          return buf;
        }
      } catch {
        adbTarget = await this.resolveTargetFlag(true);
        if (!adbTarget) {
          throw new Error('no adb device connected (run: connect <port>)');
        }
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    throw new Error('Failed to capture valid PNG screenshot from device');
  }

  /**
   * Validates that a raw RGBA buffer has no byte-shift corruption (all sampled pixels must have alpha === 255).
   */
  private isValidRawRgbaBuffer(data: Buffer, width: number, height: number): boolean {
    const totalPixels = width * height;
    if (data.length !== totalPixels * 4) return false;

    // Sample 1,200 pixels across the entire image (especially middle and bottom rows where short writes accumulate)
    const step = Math.max(1, Math.floor(totalPixels / 1200));
    let nonOpaqueCount = 0;
    for (let p = 0; p < totalPixels; p += step) {
      const alpha = data[p * 4 + 3];
      if (alpha !== 255) {
        nonOpaqueCount++;
        if (nonOpaqueCount > 2) {
          return false;
        }
      }
    }

    // Also specifically check the bottom 300 rows (e.g. Y: 2100..2399) every 37 pixels
    const bottomStartPixel = Math.max(0, (height - 300) * width);
    for (let p = bottomStartPixel; p < totalPixels; p += 37) {
      if (data[p * 4 + 3] !== 255) {
        return false;
      }
    }

    return true;
  }

  /**
   * Captures raw RGBA screen pixels into RAM.
   * Strictly validates byte length (no short-write byte drops) and alpha channel integrity.
   * If raw pipe transfer drops any bytes, automatically falls back to lossless PNG capture (`screencap -p`).
   */
  public async screencapRaw(): Promise<{
    data: Buffer;
    width: number;
    height: number;
    headerSize: number;
  }> {
    const runCapture = async () => {
      const isAdb = await this.isAdbAvailable();
      if (!isAdb) {
        throw new Error('ADB is not available in environment PATH. Failed to capture raw screen.');
      }

      let adbTarget = await this.resolveTargetFlag();
      const buildArgs = (targetFlag: string) => {
        const parts = targetFlag.trim().split(/\s+/).filter(Boolean);
        return [...parts, 'exec-out', 'screencap'];
      };

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await execFilePromise('adb', buildArgs(adbTarget), {
            encoding: 'buffer',
            maxBuffer: 30 * 1024 * 1024
          });
          const stdout = res.stdout as unknown as Buffer;

          if (stdout && stdout.length >= 16) {
            const width = stdout.readUInt32LE(0);
            const height = stdout.readUInt32LE(4);
            const format = stdout.readUInt32LE(8);
            const pixelBytes = width * height * 4;
            const headerDiff = stdout.length - pixelBytes;

            // Header MUST be strictly 16 bytes (Android 9+) or 12 bytes (older Android).
            // Any other length means `screencap` suffered a partial write() over the pipe, shifting pixel bytes!
            if (
              width > 0 &&
              width <= 10000 &&
              height > 0 &&
              height <= 10000 &&
              (format === 1 || format === 2) &&
              (headerDiff === 16 || headerDiff === 12)
            ) {
              const headerSize = headerDiff;
              const data = stdout.subarray(headerSize, headerSize + pixelBytes);
              if (this.isValidRawRgbaBuffer(data, width, height)) {
                return {
                  data,
                  width,
                  height,
                  headerSize
                };
              }
            }
          }
        } catch {
          adbTarget = await this.resolveTargetFlag(true);
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      // Fallback: capture via lossless PNG (`screencap -p`) and decode via Jimp so byte-shift is impossible
      const pngBuf = await this.screencap();
      const { Jimp } = await import('jimp');
      const img = await Jimp.fromBuffer(pngBuf);
      return {
        data: Buffer.from(img.bitmap.data),
        width: img.bitmap.width,
        height: img.bitmap.height,
        headerSize: 0
      };
    };

    const next = this.screencapChain.then(runCapture, runCapture);
    this.screencapChain = next.catch(() => {});
    return next;
  }

  /**
   * Executes an ADB shell command and returns trimmed stdout.
   */
  public async shell(cmd: string): Promise<string> {
    const isAdb = await this.isAdbAvailable();
    if (!isAdb) return '';
    try {
      const adbTarget = await this.resolveTargetFlag();
      const { stdout } = await execPromise(`adb ${adbTarget} shell "${cmd.replace(/"/g, '\\"')}"`);
      return (stdout || '').trim();
    } catch {
      return '';
    }
  }

  /**
   * Retrieves the current foreground application / game package name.
   */
  public async getForegroundApp(): Promise<string> {
    try {
      const out = await this.shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'").catch(() => '');
      const match = out.match(/([a-zA-Z0-9._]+)\/([a-zA-Z0-9._]+)/);
      if (match && match[1] && !match[1].includes('android.launcher') && !match[1].includes('nexuslauncher')) {
        return match[1].trim();
      }
    } catch {}

    try {
      const out2 = await this.shell("dumpsys activity activities | grep ResumedActivity").catch(() => '');
      const match2 = out2.match(/([a-zA-Z0-9._]+)\/([a-zA-Z0-9._]+)/);
      if (match2 && match2[1]) {
        return match2[1].trim();
      }
    } catch {}

    return '';
  }
}
