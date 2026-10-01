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
}

export class AdbController {
  private serial: string = '';
  private host: string = '';
  private autoConnectStopped = false;
  private isAutoConnecting = false;
  private autoConnectWaiters: Array<(serial: string) => void> = [];
  private tapChain: Promise<any> = Promise.resolve();
  private lastTapFinishedAt: number = 0;

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
      let command = `adb ${adbTarget} shell input touchscreen tap ${roundedX} ${roundedY}`;

      try {
        const { stdout } = await execPromise(command);
        this.lastTapFinishedAt = Date.now();
        return {
          x: roundedX,
          y: roundedY,
          command,
          success: true,
          output: stdout.trim()
        };
      } catch (err: any) {
        // Refresh target device and retry once in case Wireless Debugging port changed or reconnected
        adbTarget = await this.resolveTargetFlag(true);
        if (!adbTarget) {
          throw new Error('no adb device connected (run: connect <port>)');
        }
        command = `adb ${adbTarget} shell input touchscreen tap ${roundedX} ${roundedY}`;
        const { stdout } = await execPromise(command);
        this.lastTapFinishedAt = Date.now();
        return {
          x: roundedX,
          y: roundedY,
          command,
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
   * Captures a fresh screen buffer using a unique Date.now() temp file in os.tmpdir()
   * and deletes it immediately after reading.
   */
  public async screencap(): Promise<Buffer> {
    const isAdb = await this.isAdbAvailable();

    if (!isAdb) {
      throw new Error('ADB is not available in environment PATH. Failed to capture screen.');
    }

    let adbTarget = await this.resolveTargetFlag();
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    const tmpFile = path.join(
      os.tmpdir(),
      `screen_${Date.now()}_${Math.floor(Math.random() * 10000)}.png`
    );

    try {
      try {
        await execPromise(`adb ${adbTarget} exec-out screencap -p > "${tmpFile}"`);
      } catch {
        adbTarget = await this.resolveTargetFlag(true);
        if (!adbTarget) {
          throw new Error('no adb device connected (run: connect <port>)');
        }
        await execPromise(`adb ${adbTarget} exec-out screencap -p > "${tmpFile}"`);
      }
      const buf = await fs.promises.readFile(tmpFile);
      if (!buf || buf.length < 100) {
        throw new Error('Empty screenshot file');
      }
      return buf;
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => {});
    }
  }

  /**
   * Captures raw RGBA screen pixels directly into RAM via `adb exec-out screencap` (without -p).
   * Zero PNG compression on Android, zero temp file on disk, zero PNG decoding in Node.js.
   */
  public async screencapRaw(): Promise<{
    data: Buffer;
    width: number;
    height: number;
    headerSize: number;
  }> {
    const isAdb = await this.isAdbAvailable();
    if (!isAdb) {
      throw new Error('ADB is not available in environment PATH. Failed to capture raw screen.');
    }

    let adbTarget = await this.resolveTargetFlag();
    const buildArgs = (targetFlag: string) => {
      const parts = targetFlag.trim().split(/\s+/).filter(Boolean);
      return [...parts, 'exec-out', 'screencap'];
    };

    let stdout: Buffer;
    try {
      const res = await execFilePromise('adb', buildArgs(adbTarget), {
        encoding: 'buffer',
        maxBuffer: 30 * 1024 * 1024
      });
      stdout = res.stdout as unknown as Buffer;
    } catch {
      adbTarget = await this.resolveTargetFlag(true);
      if (!adbTarget) {
        throw new Error('no adb device connected (run: connect <port>)');
      }
      const res = await execFilePromise('adb', buildArgs(adbTarget), {
        encoding: 'buffer',
        maxBuffer: 30 * 1024 * 1024
      });
      stdout = res.stdout as unknown as Buffer;
    }

    if (!stdout || stdout.length < 16) {
      throw new Error('Empty raw screencap buffer');
    }

    const width = stdout.readUInt32LE(0);
    const height = stdout.readUInt32LE(4);
    const pixelBytes = width * height * 4;

    if (width <= 0 || width > 10000 || height <= 0 || height > 10000 || stdout.length < pixelBytes + 12) {
      throw new Error(`Unexpected raw screencap dimensions (${width}x${height}, len=${stdout.length})`);
    }

    const headerSize = stdout.length - pixelBytes >= 16 ? 16 : 12;
    const data = stdout.subarray(headerSize, headerSize + pixelBytes);

    return {
      data,
      width,
      height,
      headerSize
    };
  }
}
