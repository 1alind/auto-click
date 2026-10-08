import fs from 'fs';
import path from 'path';
import os from 'os';
import { CommandContext, CommandResult, StepLog } from './types';
import { TemplateMatcher } from './matcher';
import { RefImageManager } from './refImage';
import { screenRuleManager, ScreenRuleManager } from './screenRuleManager';
import { StoragePaths } from './storagePaths';
import { createControlButtonsJson } from './discordButtons';

export type MacroActionType =
  | 'tap'
  | 'tap_range'
  | 'wait'
  | 'screenshot'
  | 'locate_and_tap'
  | 'center_crop_webhook'
  | 'swipe'
  | 'text'
  | 'key'
  | 'loop';

export interface MacroAction {
  type: MacroActionType;
  // tap / tap_range
  x?: number;
  y?: number;
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
  // wait
  ms?: number;
  // locate_and_tap
  refPath?: string;
  threshold?: number;
  // center_crop_webhook
  cropW?: number;
  cropH?: number;
  // swipe
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  durationMs?: number;
  // text
  text?: string;
  // key (e.g. 3 = HOME, 4 = BACK, 66 = ENTER, 26 = POWER)
  keyCode?: number | string;
  // description
  label?: string;
}

export interface CustomMacro {
  name: string;
  description: string;
  createdAt: string;
  authorId?: string;
  authorTag?: string;
  steps: MacroAction[];
}

export interface StartStateStats {
  macroName: string;
  isRunning: boolean;
  resumeAfterUpdate: boolean;
  autoFixacEnabled?: boolean;
  currentStep: number;
  cycleCount: number;
  totalStepsExecuted: number;
  nextFixacRemainingMs: number;
  asCount?: number;
  acFixCount?: number;
  repairCount?: number;
  liveStatusMsgId?: string;
  updatedAt: string;
}

export async function captureCleanErrorScreenshot(
  adb: any,
  region?: { minX: number; maxX: number; minY: number; maxY: number },
  rawScreenFallback?: { data: Buffer | Uint8Array; width: number; height: number }
): Promise<Buffer | undefined> {
  if (rawScreenFallback) {
    try {
      return await TemplateMatcher.cropRawToPng(rawScreenFallback, region);
    } catch {}
  }

  try {
    const raw = await adb.screencapRaw().catch(() => null);
    if (raw && raw.data && raw.width) {
      return await TemplateMatcher.cropRawToPng(raw, region);
    }
  } catch {}

  try {
    const pngBuf = await adb.screencap().catch(() => null);
    if (pngBuf && pngBuf.length > 500) {
      if (region) {
        const { Jimp } = await import('jimp');
        const img = await Jimp.read(pngBuf);
        const w = img.bitmap.width;
        const h = img.bitmap.height;
        const cropX = Math.max(0, Math.min(region.minX, w - 1));
        const cropY = Math.max(0, Math.min(region.minY, h - 1));
        const cropW = Math.max(1, Math.min(region.maxX - cropX, w - cropX));
        const cropH = Math.max(1, Math.min(region.maxY - cropY, h - cropY));
        img.crop({ x: cropX, y: cropY, w: cropW, h: cropH });
        return await img.getBuffer('image/png');
      }
      return pngBuf;
    }
  } catch (err: any) {
    console.warn('[ErrorScreenshot] adb.screencap failed, falling back:', err?.message);
  }

  return undefined;
}

function resolveStartStateFilePath(): string {
  return StoragePaths.getStartStatePath();
}

function resolveMacrosFilePath(): string {
  return StoragePaths.getMacrosPath();
}

function resolveCustomImagePath(imageName: string): string {
  const clean = imageName.trim();
  const resolved = StoragePaths.resolveImage(clean);
  if (resolved) return resolved;
  const hasExt = /\.[a-z0-9]+$/i.test(clean);
  return path.join(StoragePaths.getImagesDir(), hasExt ? clean : `${clean}.jpg`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MacroManager {
  private static macros: Map<string, CustomMacro> = new Map();
  private static activeRunId = 0;
  private static stopRequestedForRunId = 0;
  private static stoppingForUpdate = false;
  private static runningMacroName: string | null = null;
  private static cycleStopWaiters: Array<() => void> = [];
  private static liveStatusInterval: NodeJS.Timeout | null = null;

  private static findRunning = false;
  private static findWaiters: Array<() => void> = [];
  private static manualFixacPending: {
    ctx: CommandContext;
    resolve: (res: CommandResult) => void;
  } | null = null;

  public static isStartRunning(): boolean {
    return this.runningMacroName?.toLowerCase() === 'start';
  }

  public static async requestManualFixacDuringStart(ctx: CommandContext): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve) => {
      this.manualFixacPending = { ctx, resolve };
    });
  }

  public static loadStartState(): StartStateStats {
    const filePath = resolveStartStateFilePath();
    const defaults: StartStateStats = {
      macroName: 'start',
      isRunning: false,
      resumeAfterUpdate: false,
      autoFixacEnabled: true,
      currentStep: 1,
      cycleCount: 0,
      totalStepsExecuted: 0,
      nextFixacRemainingMs: 300000,
      asCount: 0,
      acFixCount: 0,
      repairCount: 0,
      liveStatusMsgId: undefined,
      updatedAt: new Date().toISOString()
    };
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return { ...defaults, ...parsed };
      }
    } catch {
      // ignore read error
    }
    return defaults;
  }

  public static saveStartState(partial: Partial<StartStateStats>): StartStateStats {
    const current = this.loadStartState();
    const updated: StartStateStats = {
      ...current,
      ...partial,
      updatedAt: new Date().toISOString()
    };
    try {
      const filePath = resolveStartStateFilePath();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
    } catch {
      // ignore write error
    }
    return updated;
  }

  public static init(): void {
    this.loadMacros();
  }

  /**
   * Marks `find` as running. While `find` is running, nothing can stop it and all other tasks/updates must wait.
   */
  public static beginFind(): void {
    this.findRunning = true;
  }

  public static endFind(): void {
    this.findRunning = false;
    const waiters = this.cycleFindWaiters();
    for (const resolve of waiters) resolve();
  }

  private static cycleFindWaiters(): Array<() => void> {
    const list = [...this.findWaiters];
    this.findWaiters = [];
    return list;
  }

  public static isFindRunning(): boolean {
    return this.findRunning;
  }

  public static async waitForFind(): Promise<void> {
    while (this.findRunning) {
      await new Promise<void>((resolve) => this.findWaiters.push(resolve));
    }
  }

  /**
   * Requests the currently running macro (e.g. `start`) to stop at the next boundary (Step 1, 7, or 13),
   * and waits until it reaches that exact boundary.
   */
  public static async stopAllAndWait(): Promise<string | null> {
    // Never stop `find` — wait if `find` is running
    if (this.findRunning) {
      await this.waitForFind();
    }
    const targetName = this.runningMacroName;
    if (!targetName) return null;

    this.stopRequestedForRunId = this.activeRunId;
    await new Promise<void>((resolve) => this.cycleStopWaiters.push(resolve));
    return targetName;
  }

  /**
   * Stops `start` at the next safe step boundary (1, 7, or 13) specifically for a GitHub update,
   * marking `resumeAfterUpdate: true` in `/sdcard/autoclick/start-state.json`.
   */
  public static async stopForUpdateAndWait(): Promise<string | null> {
    if (this.findRunning) {
      await this.waitForFind();
    }
    const targetName = this.runningMacroName;
    if (!targetName) return null;

    this.stoppingForUpdate = true;
    this.stopRequestedForRunId = this.activeRunId;
    await new Promise<void>((resolve) => this.cycleStopWaiters.push(resolve));
    return targetName;
  }

  /**
   * Checks `/sdcard/autoclick/start-state.json` on startup and automatically resumes `start`
   * from its saved step if it was paused for an update.
   */
  public static async resumeStartIfNeeded(): Promise<void> {
    const state = this.loadStartState();
    if (!state.resumeAfterUpdate) return;

    this.saveStartState({ resumeAfterUpdate: false });
    const startMacro = this.getMacro(state.macroName || 'start');
    if (!startMacro) return;

    const { botManager } = await import('./botManager');
    const webhook = botManager.getWebhookService();

    const resumeStep = state.currentStep || 1;
    if (webhook.isConfigured()) {
      await webhook
        .send({
          content: `🔄 Update complete — resuming \`${startMacro.name}\` from **step ${resumeStep}** (cycle #${state.cycleCount}, total steps: ${state.totalStepsExecuted})...`
        })
        .catch(() => {});
    }

    const ctx: CommandContext = {
      commandName: startMacro.name,
      args: state.autoFixacEnabled ? ['fixac'] : [],
      author: { id: 'system', tag: 'auto-resume', username: 'auto-resume' },
      channelId: '1553844985776836638',
      reply: async (msg: string) => {
        if (webhook.isConfigured()) {
          await webhook.send({ content: msg }).catch(() => {});
        }
      },
      log: (msg: string, level = 'info', meta?: any) => {
        // log via botManager
        console.log(`[AutoResume][${level}] ${msg}`, meta || '');
      }
    };

    void this.executeMacro(startMacro, ctx, {
      resumeStep,
      initialFixacDelayMs: state.nextFixacRemainingMs
    });
  }

  public static stopAll(): string | null {
    const targetName = this.runningMacroName;
    if (!targetName) return null;
    this.stopRequestedForRunId = this.activeRunId;
    return targetName;
  }

  private static notifyCycleStopped(): void {
    if (this.liveStatusInterval) {
      clearInterval(this.liveStatusInterval);
      this.liveStatusInterval = null;
    }
    this.runningMacroName = null;
    const waiters = [...this.cycleStopWaiters];
    this.cycleStopWaiters = [];
    for (const resolve of waiters) resolve();
  }

  public static getRunningMacro(): string | null {
    return this.runningMacroName;
  }

  public static getMacros(): CustomMacro[] {
    return Array.from(this.macros.values());
  }

  public static getMacro(name: string): CustomMacro | undefined {
    return this.macros.get(name.toLowerCase());
  }

  public static saveMacro(macro: CustomMacro): void {
    this.macros.set(macro.name.toLowerCase(), macro);
    this.persist();
  }

  public static deleteMacro(name: string): boolean {
    const deleted = this.macros.delete(name.toLowerCase());
    if (deleted) this.persist();
    return deleted;
  }

  /**
   * Parses text lines or single-line command sequences from Discord to create a multi-step macro.
   */
  public static parseMacroScript(name: string, scriptText: string, author?: { id: string; tag: string }): CustomMacro {
    // Normalize en-dash/em-dash and "X: 465 - 602" style spacing into "465-602"
    const cleanedScript = scriptText
      .replace(/[–—]/g, '-')
      .replace(/\b[xy]\s*:\s*/gi, '')
      .replace(/(\d+)\s*-\s*(\d+)/g, '$1-$2');

    // Split into logical step segments whether separated by newlines, semicolons, numbered steps, or action keywords
    const normalized = cleanedScript
      .replace(/\r\n/g, '\n')
      .replace(/;/g, '\n')
      .replace(/(?:^|\s+)(?:step\s+)?\d+[\.\)\:\-]\s*/gi, '\n')
      .replace(/\s+(?=(?:tap|click|wait|sleep|delay|locate|search|find|match|crop|crop_webhook|webhook|screenshot|snap|swipe|scroll|text|type|key|keyevent|loop|repeat)\b)/gi, '\n');

    const lines = normalized.split('\n').map((l) => l.trim()).filter(Boolean);
    const steps: MacroAction[] = [];

    for (const rawLine of lines) {
      const line = rawLine.replace(/^(?:step\s+)?\d+[\.\)\:\-]\s*/i, '').trim();
      if (!line) continue;

      const parts = line.split(/\s+/);
      const action = parts[0].toLowerCase();

      if (action === 'tap' || action === 'click' || (/^\d+-\d+$/.test(parts[0] || '') && /^\d+-\d+$/.test(parts[1] || ''))) {
        const isBareCoords = action !== 'tap' && action !== 'click';
        const arg1 = isBareCoords ? (parts[0] || '') : (parts[1] || '');
        const arg2 = isBareCoords ? (parts[1] || '') : (parts[2] || '');

        if (arg1.includes('-') || arg2.includes('-')) {
          const [minX, maxX] = arg1.split('-').map(Number);
          const [minY, maxY] = arg2.split('-').map(Number);
          steps.push({
            type: 'tap_range',
            minX: minX || 0,
            maxX: maxX || minX || 0,
            minY: minY || 0,
            maxY: maxY || minY || 0,
            label: `Random Tap X=[${minX}..${maxX}], Y=[${minY}..${maxY}]`
          });
        } else {
          const x = parseInt(arg1, 10) || 0;
          const y = parseInt(arg2, 10) || 0;
          steps.push({
            type: 'tap',
            x,
            y,
            label: `Tap (${x}, ${y})`
          });
        }
      } else if (action === 'loop' || action === 'repeat') {
        steps.push({
          type: 'loop',
          label: 'Loop from step 1'
        });
      } else if (action === 'wait' || action === 'sleep' || action === 'delay' || /^\d+(\.\d+)?s?$/i.test(action)) {
        const rawTime = /^\d/.test(action) ? action : (parts[1] || '1000');
        const unit = /^\d/.test(action) ? (parts[1] || '') : (parts[2] || '');
        const num = parseFloat(rawTime) || 0;
        let ms = Math.round(num);
        if (
          rawTime.toLowerCase().endsWith('s') && !rawTime.toLowerCase().endsWith('ms') ||
          /^sec/i.test(unit) ||
          (num > 0 && num < 30 && rawTime.includes('.'))
        ) {
          ms = Math.round(num * 1000);
        }
        steps.push({
          type: 'wait',
          ms,
          label: `Wait ${ms}ms`
        });
      } else if (action === 'locate' || action === 'search' || action === 'find' || action === 'match') {
        const refPath = parts[1] || 'pfp.jpg';
        const arg2 = parts[2] || '';
        const arg3 = parts[3] || '';
        let minX: number | undefined;
        let maxX: number | undefined;
        let minY: number | undefined;
        let maxY: number | undefined;

        if (arg2.includes('-') && arg3.includes('-')) {
          [minX, maxX] = arg2.split('-').map(Number);
          [minY, maxY] = arg3.split('-').map(Number);
        }

        steps.push({
          type: 'locate_and_tap',
          refPath,
          minX,
          maxX,
          minY,
          maxY,
          threshold: 0.75,
          label:
            minX !== undefined && maxX !== undefined && minY !== undefined && maxY !== undefined
              ? `Search "${refPath}" in X=[${minX}..${maxX}], Y=[${minY}..${maxY}] & tap`
              : `Search "${refPath}" & tap`
        });
      } else if (action === 'crop' || action === 'crop_webhook' || action === 'webhook') {
        let w = 150, h = 150;
        if (parts[1] && parts[1].includes('x')) {
          const [pw, ph] = parts[1].split('x').map(Number);
          if (pw) w = pw;
          if (ph) h = ph;
        } else if (parts[1] && /^\d+$/.test(parts[1])) {
          w = parseInt(parts[1], 10);
          h = w;
        }
        steps.push({
          type: 'center_crop_webhook',
          cropW: w,
          cropH: h,
          label: `Center crop ${w}x${h} & send Discord webhook`
        });
      } else if (action === 'screenshot' || action === 'snap') {
        steps.push({
          type: 'screenshot',
          label: 'Capture full Android screenshot'
        });
      } else if (action === 'swipe' || action === 'scroll' || action === 'move' || action === 'pan') {
        const dir = (parts[1] || '').toLowerCase();
        if (['up', 'down', 'left', 'right'].includes(dir)) {
          const dist = parseInt(parts[2], 10) || 500;
          let x1 = 540, y1 = 1200, x2 = 540, y2 = 1200;
          if (dir === 'up') { y1 = 1200 - Math.floor(dist / 2); y2 = 1200 + Math.floor(dist / 2); }
          else if (dir === 'down') { y1 = 1200 + Math.floor(dist / 2); y2 = 1200 - Math.floor(dist / 2); }
          else if (dir === 'left') { x1 = 540 - Math.floor(dist / 2); x2 = 540 + Math.floor(dist / 2); }
          else if (dir === 'right') { x1 = 540 + Math.floor(dist / 2); x2 = 540 - Math.floor(dist / 2); }
          steps.push({
            type: 'swipe',
            startX: x1,
            startY: y1,
            endX: x2,
            endY: y2,
            durationMs: 400,
            label: `Pan map ${dir} by ${dist}px`
          });
        } else {
          const x1 = parseInt(parts[1], 10) || 500;
          const y1 = parseInt(parts[2], 10) || 1500;
          const x2 = parseInt(parts[3], 10) || 500;
          const y2 = parseInt(parts[4], 10) || 500;
          const duration = parseInt(parts[5], 10) || 300;
          steps.push({
            type: 'swipe',
            startX: x1,
            startY: y1,
            endX: x2,
            endY: y2,
            durationMs: duration,
            label: `Swipe (${x1},${y1}) -> (${x2},${y2}) in ${duration}ms`
          });
        }
      } else if (action === 'text' || action === 'type') {
        const text = parts.slice(1).join(' ');
        steps.push({
          type: 'text',
          text,
          label: `Input text: "${text}"`
        });
      } else if (action === 'key' || action === 'keyevent') {
        const keyCode = parts[1] || '3';
        steps.push({
          type: 'key',
          keyCode,
          label: `Press keycode ${keyCode}`
        });
      }
    }

    return {
      name: name.toLowerCase(),
      description: `Custom macro with ${steps.length} steps`,
      createdAt: new Date().toISOString(),
      authorId: author?.id,
      authorTag: author?.tag,
      steps
    };
  }

  /**
   * Executes a custom macro step by step on the Android device and updates progress via Discord webhook message ID.
   */
  public static async executeMacro(
    macro: CustomMacro,
    ctx: CommandContext,
    options?: { resumeStep?: number; initialFixacDelayMs?: number }
  ): Promise<CommandResult> {
    const { botManager } = await import('./botManager');
    const adb = botManager.getAdbController();
    const webhook = botManager.getWebhookService();
    const stepsLog: StepLog[] = [];

    // Wait if `find` is currently working
    if (this.findRunning) {
      ctx.log(`⏳ Waiting for "find" to finish before starting "${macro.name}"...`, 'info');
      await this.waitForFind();
    }

    // If another macro is currently running, wait for it to finish its cycle right before step 1
    if (this.runningMacroName) {
      await this.stopAllAndWait();
    }

    const runId = ++this.activeRunId;
    this.runningMacroName = macro.name;
    this.stoppingForUpdate = false;
    const isStartMacro = macro.name.toLowerCase() === 'start';
    const isLoopMacro = macro.steps.some((s) => s.type === 'loop');

    const persistedState = isStartMacro ? this.loadStartState() : null;
    const isResuming = Boolean(options?.resumeStep && options.resumeStep > 1);
    let loopCount = isResuming && persistedState ? persistedState.cycleCount : 0;
    let totalStepsExecuted = isResuming && persistedState ? persistedState.totalStepsExecuted : 0;
    let asCount = isResuming && persistedState?.asCount !== undefined ? persistedState.asCount : loopCount * 4;
    let acFixCount = isResuming && persistedState?.acFixCount !== undefined ? persistedState.acFixCount : 0;
    let repairCount = isResuming && persistedState?.repairCount !== undefined ? persistedState.repairCount : 0;
    let liveStatusMsgId: string | undefined = isResuming ? persistedState?.liveStatusMsgId : undefined;

    const formatTimeNow = (): string => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const getLiveStatusContent = (statusText: string = 'working'): string => {
      return [
        `-# airstrike ${statusText}`,
        `-# AS count: ${asCount}`,
        `-# AC-Fix count: ${acFixCount}`,
        `-# repair-count: ${repairCount}`,
        `-# datenow: ${formatTimeNow()}`
      ].join('\n');
    };

    const updateLiveStatus = async (statusText: string = 'working') => {
      if (!webhook.isConfigured()) return;
      const content = getLiveStatusContent(statusText);
      const components = createControlButtonsJson(statusText === 'working');
      try {
        if (!liveStatusMsgId) {
          const res = await webhook.send({ content, rawContent: true, components });
          if (res.success && res.messageId) {
            liveStatusMsgId = res.messageId;
          }
        } else {
          const editRes = await webhook.edit(liveStatusMsgId, { content, rawContent: true, components });
          if (!editRes.success) {
            const res = await webhook.send({ content, rawContent: true, components });
            if (res.success && res.messageId) {
              liveStatusMsgId = res.messageId;
            }
          }
        }
      } catch {
        // ignore transient network error
      }
    };

    ctx.log(`🎬 Running custom macro "${macro.name}" (${macro.steps.length} steps)...`, 'info');

    let lastScreenshotBuffer: Buffer | null = null;
    let sentCropImage = false;
    let progressMsgId: string | undefined;

    const updateProgress = async (text: string) => {
      if (!webhook.isConfigured()) return;
      try {
        if (!progressMsgId) {
          const res = await webhook.send({ content: text });
          if (res.success && res.messageId) {
            progressMsgId = res.messageId;
          }
        } else {
          await webhook.edit(progressMsgId, { content: text });
        }
      } catch {
        // ignore transient webhook progress errors
      }
    };

    const autoFixacEnabled =
      isStartMacro && (!Array.isArray(ctx.args) || !ctx.args.some((a) => a.toLowerCase() === 'nofixac'));

    if (isLoopMacro && !isStartMacro) {
      await updateProgress(`${macro.name}: loop started (send \`stop\` to stop before step 1)`);
    }

    // Random interval between 5 and 6 minutes (300,000ms to 360,000ms) for auto-running fixac during `start fixac`
    const getNextFixacDelayMs = () => (300 + Math.floor(Math.random() * 61)) * 1000;
    let nextFixacAt =
      Date.now() +
      (options?.initialFixacDelayMs && options.initialFixacDelayMs > 5000
        ? Math.min(options.initialFixacDelayMs, 360000)
        : getNextFixacDelayMs());

    const initialIndex =
      options?.resumeStep && options.resumeStep >= 1 && options.resumeStep <= macro.steps.length
        ? options.resumeStep - 1
        : 0;

    // Helper to capture and store a 100x100 px reference crop of Step 1's center (X:483..583, Y:1116..1216) in RAM
    const captureStep1RefInRam = async () => {
      try {
        const initScreen = await adb.screencapRaw();
        const crop100x100 = await TemplateMatcher.cropRawToPng(initScreen, {
          minX: 483,
          maxX: 583,
          minY: 1116,
          maxY: 1216
        });
        await TemplateMatcher.setInMemoryTemplate('ram://step1.png', crop100x100);
      } catch {}
    };

    if (isStartMacro) {
      await captureStep1RefInRam();
      this.saveStartState({
        macroName: macro.name,
        isRunning: true,
        resumeAfterUpdate: false,
        autoFixacEnabled,
        currentStep: initialIndex + 1,
        cycleCount: loopCount,
        totalStepsExecuted,
        nextFixacRemainingMs: Math.max(0, nextFixacAt - Date.now()),
        asCount,
        acFixCount,
        repairCount,
        liveStatusMsgId
      });

      // Post initial live status message & update every 1 min while start is working
      await updateLiveStatus('working');
      if (MacroManager.liveStatusInterval) {
        clearInterval(MacroManager.liveStatusInterval);
      }
      MacroManager.liveStatusInterval = setInterval(() => {
        updateLiveStatus('working').catch(() => {});
      }, 60 * 1000);
    }

    let consecutiveRescuesOnStep = 0;
    let lastRescuedStep = -1;

    for (let i = initialIndex; i < macro.steps.length; i++) {
      if (lastRescuedStep !== i) {
        consecutiveRescuesOnStep = 0;
      }
      const step = macro.steps[i];
      const stepNumber = i + 1;
      const isStopBoundary =
        i === 0 ||
        (isStartMacro && (stepNumber === 1 || stepNumber === 7 || stepNumber === 13 || stepNumber === 19));

      // Check for stop or 5-6m fixac interval right before Step 1, Step 7, Step 13, or Step 19 (process boundaries)
      if (isStopBoundary) {
        if (isStartMacro) {
          // Check if Launch Formation screen is already open before tapping RAB
          const screenPng = await TemplateMatcher.cropRawToPng(await adb.screencapRaw());
          const isLF = await ScreenRuleManager.isLaunchFormationScreen(adb, screenPng);
          if (isLF) {
            await ScreenRuleManager.dismissLaunchFormation(adb, ctx);
            const roundIndex = Math.min(3, Math.floor(i / 6));
            const roundBaseStepIdx = roundIndex * 6;
            const roundAsBtnStepIdx = roundBaseStepIdx + 2;
            i = roundAsBtnStepIdx - 1; // Proceed directly to asbtn.png
            continue;
          }

          // Check if Repair modal is open before tapping RAB
          const repairHandled = await ScreenRuleManager.checkAndHandleRepairModal(adb, screenPng, ctx);
          if (repairHandled) {
            repairCount++;
            const roundIndex = Math.min(3, Math.floor(i / 6));
            const roundBaseStepIdx = roundIndex * 6;
            const roundAsBtnStepIdx = roundBaseStepIdx + 2;
            i = roundAsBtnStepIdx - 1;
            continue;
          }

          this.saveStartState({
            isRunning: true,
            autoFixacEnabled,
            currentStep: stepNumber,
            cycleCount: loopCount,
            totalStepsExecuted,
            nextFixacRemainingMs: Math.max(0, nextFixacAt - Date.now()),
            asCount,
            acFixCount,
            repairCount,
            liveStatusMsgId
          });
        }

        if (this.findRunning) {
          await this.waitForFind();
        }
        if (this.stopRequestedForRunId === runId || this.activeRunId !== runId) {
          const pausedForUpdate = this.stoppingForUpdate;
          this.stoppingForUpdate = false;
          if (isStartMacro) {
            this.saveStartState({
              isRunning: false,
              resumeAfterUpdate: pausedForUpdate,
              autoFixacEnabled,
              currentStep: stepNumber,
              cycleCount: loopCount,
              totalStepsExecuted,
              nextFixacRemainingMs: Math.max(0, nextFixacAt - Date.now()),
              asCount,
              acFixCount,
              repairCount,
              liveStatusMsgId
            });
            await updateLiveStatus('stopped');
          }
          this.notifyCycleStopped();
          const stoppedMsg = pausedForUpdate
            ? `${macro.name}: paused before step ${stepNumber} for update (will auto-resume)`
            : `${macro.name}: stopped before step ${stepNumber}`;
          ctx.log(`🛑 "${macro.name}" stopped cleanly right before step ${stepNumber}.`, 'info');
          await updateProgress(stoppedMsg);
          return { success: true, message: stoppedMsg, steps: stepsLog };
        }

        // Run `fixac` if manually requested during `start`, or every 5-6 minutes automatically ONLY if started via `start fixac`
        if (isStartMacro && (this.manualFixacPending || (autoFixacEnabled && Date.now() >= nextFixacAt))) {
          const manualReq = this.manualFixacPending;
          this.manualFixacPending = null;
          const isManual = Boolean(manualReq);

          if (isManual) {
            ctx.log(`⏸️ [Manual-fixac] Pausing "${macro.name}" before step ${stepNumber} to run manual "fixac"...`, 'info');
            await updateProgress(`${macro.name}: paused before step ${stepNumber} — running \`fixac\`...`);
          } else {
            ctx.log(`⏸️ [Auto-fixac] 5–6m timer reached! Pausing "${macro.name}" before step ${stepNumber} to run "fixac" silently...`, 'info');
          }

          const { fixacCommand } = await import('./commands/fixac');
          const fixacCtx: CommandContext = isManual
            ? { ...manualReq!.ctx, args: ['--direct', '--during-start'] }
            : { ...ctx, args: ['--silent', '--direct', '--during-start'], reply: undefined };
          const fixacResult = await fixacCommand.execute(fixacCtx);
          acFixCount++;

          if (manualReq) {
            manualReq.resolve(fixacResult);
          }

          // Check if user sent `stop` or update requested while `fixac` was running
          if (this.stopRequestedForRunId === runId || this.activeRunId !== runId) {
            const pausedForUpdate = this.stoppingForUpdate;
            this.stoppingForUpdate = false;
            nextFixacAt = Date.now() + getNextFixacDelayMs();
            if (isStartMacro) {
              this.saveStartState({
                isRunning: false,
                resumeAfterUpdate: pausedForUpdate,
                currentStep: stepNumber,
                cycleCount: loopCount,
                totalStepsExecuted,
                nextFixacRemainingMs: Math.max(0, nextFixacAt - Date.now()),
                asCount,
                acFixCount,
                repairCount,
                liveStatusMsgId
              });
              await updateLiveStatus('stopped');
            }
            this.notifyCycleStopped();
            const stoppedMsg = pausedForUpdate
              ? `${macro.name}: paused before step ${stepNumber} for update`
              : `${macro.name}: stopped before step ${stepNumber}`;
            ctx.log(`🛑 "${macro.name}" stopped cleanly right before step ${stepNumber} after fixac.`, 'info');
            await updateProgress(stoppedMsg);
            return { success: true, message: stoppedMsg, steps: stepsLog };
          }

          nextFixacAt = Date.now() + getNextFixacDelayMs();
          await sleep(600);
          await captureStep1RefInRam();

          if (!fixacResult.success) {
            ctx.log(
              `⚠️ [${isManual ? 'Manual' : 'Auto'}-fixac] ${fixacResult.message} — continuing "${macro.name}" from step ${stepNumber}...`,
              'warn'
            );
            if (isManual) {
              await updateProgress(`${macro.name}: \`fixac\` finished — continuing from step ${stepNumber}`);
            }
          } else {
            ctx.log(`▶️ [${isManual ? 'Manual' : 'Auto'}-fixac] "fixac" completed! Resuming "${macro.name}" from step ${stepNumber}...`, 'info');
            if (isManual) {
              await updateProgress(`${macro.name}: \`fixac\` done — resuming from step ${stepNumber}`);
            }
          }
        }
      }

      totalStepsExecuted++;

      const title = step.label || `Step ${stepNumber}: ${step.type}`;

      ctx.log(`[Step ${stepNumber}/${macro.steps.length}] ${title}`, 'step');
      if (ctx.notifyStep) {
        ctx.notifyStep(stepNumber, title, step.type, 'running');
      }

      if (!isLoopMacro && step.type !== 'wait') {
        await updateProgress(`${macro.name}: step ${stepNumber} (${step.type})`);
      }

      try {
        switch (step.type) {
          case 'tap': {
            const x = step.x ?? 500;
            const y = step.y ?? 1000;
            await adb.tap(x, y);
            break;
          }

          case 'tap_range': {
            const minX = step.minX ?? 0;
            const maxX = step.maxX ?? 100;
            const minY = step.minY ?? 0;
            const maxY = step.maxY ?? 100;
            await adb.tapRandomRange(minX, maxX, minY, maxY);
            break;
          }

          case 'wait': {
            const ms = Math.max(100, Number(step.ms) || 600);
            await sleep(ms);
            break;
          }

          case 'loop': {
            loopCount++;
            if (isStartMacro && asCount < loopCount * 4) {
              asCount = loopCount * 4;
            }
            // Right before Step 1 starts again: check if stop was requested!
            if (this.stopRequestedForRunId === runId || this.activeRunId !== runId) {
              const pausedForUpdate = this.stoppingForUpdate;
              this.stoppingForUpdate = false;
              if (isStartMacro) {
                this.saveStartState({
                  isRunning: false,
                  resumeAfterUpdate: pausedForUpdate,
                  currentStep: 1,
                  cycleCount: loopCount,
                  totalStepsExecuted,
                  nextFixacRemainingMs: Math.max(0, nextFixacAt - Date.now()),
                  asCount,
                  acFixCount,
                  repairCount,
                  liveStatusMsgId
                });
                await updateLiveStatus('stopped');
              }
              this.notifyCycleStopped();
              const stoppedMsg = pausedForUpdate
                ? `${macro.name}: paused before step 1 for update (will auto-resume)`
                : `${macro.name}: stopped before step 1`;
              ctx.log(`🛑 "${macro.name}" stopped cleanly right before step 1 (completed ${loopCount} loop(s)).`, 'info');
              await updateProgress(stoppedMsg);
              return { success: true, message: stoppedMsg, steps: stepsLog };
            }
            if (isStartMacro) {
              this.saveStartState({
                isRunning: true,
                currentStep: 1,
                cycleCount: loopCount,
                totalStepsExecuted,
                nextFixacRemainingMs: Math.max(0, nextFixacAt - Date.now()),
                asCount,
                acFixCount,
                repairCount,
                liveStatusMsgId
              });
            }
            if (this.findRunning) {
              await this.waitForFind();
            }
            ctx.log(`🔁 Loop #${loopCount} completed for "${macro.name}", restarting from step 1...`, 'info');
            i = -1; // Next iteration of for-loop increments i to 0 (Step 1)
            continue;
          }

          case 'screenshot': {
            lastScreenshotBuffer = await adb.screencap();
            break;
          }

          case 'locate_and_tap': {
            const targetName = step.refPath || 'pfp.png';
            if (!isLoopMacro) {
              await updateProgress(`${macro.name}: step ${stepNumber} searching for ${targetName}`);
            }
            const rawScreen = await adb.screencapRaw();

            const isRamTemplate = targetName.startsWith('ram://');
            const resolvedImgPath = isRamTemplate
              ? targetName
              : targetName === 'pfp' || targetName === 'pfp.png' || targetName === 'pfp.jpg'
              ? await RefImageManager.ensureRefImage()
              : resolveCustomImagePath(targetName);

            const config = botManager.getConfig();
            const hasCustomRegion =
              step.minX !== undefined &&
              step.maxX !== undefined &&
              step.minY !== undefined &&
              step.maxY !== undefined;

            const region = hasCustomRegion
              ? { minX: step.minX!, maxX: step.maxX!, minY: step.minY!, maxY: step.maxY! }
              : targetName.startsWith('pfp')
              ? { minX: 79, maxX: 220, minY: 523, maxY: 1721 }
              : undefined;

            let tapX = 0;
            let tapY = 0;

            const templateAvailable = isRamTemplate
              ? TemplateMatcher.hasInMemoryTemplate(targetName)
              : Boolean(resolvedImgPath && fs.existsSync(resolvedImgPath));

            if (templateAvailable && resolvedImgPath) {
              const effectiveThreshold = step.threshold || config.matchThreshold || 0.75;
              const match = await TemplateMatcher.matchRaw(rawScreen, resolvedImgPath, {
                scales: [0.7, 0.85, 1.0, 1.15, 1.3],
                threshold: effectiveThreshold,
                region
              });

              if (match.found) {
                tapX = match.targetPoint.x;
                tapY = match.targetPoint.y;
                ctx.log(`✅ Visual Match (${targetName}): image is SAME (${(match.score * 100).toFixed(1)}% match in ${match.executionTimeMs}ms). Clicking inside image at (${tapX}, ${tapY})`, 'info');
                await adb.tap(tapX, tapY);
                if (isStartMacro && /as[1-4]\.png/i.test(step.refPath || '')) {
                  asCount++;
                }
                if (!isLoopMacro) {
                  await updateProgress(`${macro.name}: step ${stepNumber} clicked ${targetName} (${(match.score * 100).toFixed(1)}%)`);
                }
              } else if (isStartMacro) {
                // 1. Check screen rules FIRST (e.g. Launch Formation screen or unexpected modal)
                const screenPng = await TemplateMatcher.cropRawToPng(rawScreen);
                const isLF = await ScreenRuleManager.isLaunchFormationScreen(adb, screenPng);
                if (isLF) {
                  await ScreenRuleManager.dismissLaunchFormation(adb, ctx);
                  const roundIndex = Math.min(3, Math.floor(i / 6));
                  const roundBaseStepIdx = roundIndex * 6;
                  const roundAsBtnStepIdx = roundBaseStepIdx + 2;
                  i = roundAsBtnStepIdx - 1;
                  continue;
                }

                // 2. Check for Repair text modal (Area 1: 566-946, 1707-1801 -> Area 2: 605-997, 2177-2279)
                const repairHandled = await ScreenRuleManager.checkAndHandleRepairModal(adb, screenPng, ctx);
                if (repairHandled) {
                  repairCount++;
                  // After repair, check which button of the loop is on screen and continue loop
                  const freshScreen = await adb.screencapRaw();
                  const roundIndex = Math.min(3, Math.floor(i / 6));
                  const roundBaseStepIdx = roundIndex * 6;
                  const roundAsBtnStepIdx = roundBaseStepIdx + 2;
                  const roundAsNumStepIdx = roundBaseStepIdx + 4;

                  const repairCandidates = [
                    {
                      stepIdx: roundAsBtnStepIdx,
                      refName: 'asbtn.png',
                      region: { minX: 771, maxX: 840, minY: 1107, maxY: 1176 }
                    },
                    {
                      stepIdx: roundAsNumStepIdx,
                      refName: macro.steps[roundAsNumStepIdx]?.refPath || `as${roundIndex + 1}.png`,
                      region: {
                        minX: macro.steps[roundAsNumStepIdx]?.minX ?? 230,
                        maxX: macro.steps[roundAsNumStepIdx]?.maxX ?? 625,
                        minY: macro.steps[roundAsNumStepIdx]?.minY ?? 1622,
                        maxY: macro.steps[roundAsNumStepIdx]?.maxY ?? 1707
                      }
                    }
                  ];

                  // Also check any other round's formation button in case loop desynced
                  for (let r = 0; r < 4; r++) {
                    if (r === roundIndex) continue;
                    const rNumStep = r * 6 + 4;
                    repairCandidates.push({
                      stepIdx: rNumStep,
                      refName: macro.steps[rNumStep]?.refPath || `as${r + 1}.png`,
                      region: {
                        minX: macro.steps[rNumStep]?.minX ?? 230,
                        maxX: macro.steps[rNumStep]?.maxX ?? 625,
                        minY: macro.steps[rNumStep]?.minY ?? 1622,
                        maxY: macro.steps[rNumStep]?.maxY ?? 1707
                      }
                    });
                  }

                  let recoveredAfterRepair = false;
                  for (const cand of repairCandidates) {
                    const candPath = resolveCustomImagePath(cand.refName);
                    if (!candPath || !fs.existsSync(candPath)) continue;
                    const candMatch = await TemplateMatcher.matchRaw(freshScreen, candPath, {
                      scales: [0.7, 0.85, 1.0, 1.15, 1.3],
                      threshold: effectiveThreshold,
                      region: cand.region
                    });
                    if (candMatch.found) {
                      await adb.tap(candMatch.targetPoint.x, candMatch.targetPoint.y);
                      if (isStartMacro && /as[1-4]\.png/i.test(cand.refName || '')) {
                        asCount++;
                      }
                      i = cand.stepIdx;
                      recoveredAfterRepair = true;
                      break;
                    }
                  }

                  if (!recoveredAfterRepair) {
                    i = roundAsBtnStepIdx - 1;
                  }
                  continue;
                }

                const earlyRuleCheck = await screenRuleManager.checkAndExecuteRule(adb, screenPng);
                if (earlyRuleCheck.matched && earlyRuleCheck.rule) {
                  lastRescuedStep = i;
                  consecutiveRescuesOnStep++;
                  const actionDesc =
                    earlyRuleCheck.rule.action.type === 'sequence'
                      ? 'Closed Launch Formation (Back) and clicked center of screen (RAB)'
                      : earlyRuleCheck.rule.action.type === 'tap'
                      ? `Tapped (${earlyRuleCheck.rule.action.x}, ${earlyRuleCheck.rule.action.y})`
                      : earlyRuleCheck.rule.action.type === 'back'
                      ? 'Pressed Back button'
                      : `Tapped range ${earlyRuleCheck.rule.action.minX}-${earlyRuleCheck.rule.action.maxX}`;

                  ctx.log(
                    `🛡️ Screen Rule Handled: Recognized "${earlyRuleCheck.rule.id}"! ${actionDesc}. Resuming loop quietly...`,
                    'info'
                  );

                  const roundIndex = Math.min(3, Math.floor(i / 6));
                  const roundBaseStepIdx = roundIndex * 6;
                  const roundAsBtnStepIdx = roundBaseStepIdx + 2;

                  if (earlyRuleCheck.rule.id.toLowerCase() === 'launch_formation') {
                    // Center of screen was tapped, now proceed directly to click asbtn.png
                    i = roundAsBtnStepIdx - 1;
                    continue;
                  }

                  await sleep(500);
                  i--;
                  continue;
                }

                // One-by-one button recovery for `start`:
                const roundIndex = Math.min(3, Math.floor(i / 6)); // 0: steps 1-6, 1: steps 7-12, 2: steps 13-18, 3: steps 19-24
                const roundBaseStepIdx = roundIndex * 6; // 0, 6, 12, or 18 (Step 1, 7, 13, or 19)
                const roundAsBtnStepIdx = roundBaseStepIdx + 2; // 2, 8, 14, or 20 (Step 3, 9, 15, or 21)
                const roundAsNumStepIdx = roundBaseStepIdx + 4; // 4, 10, 16, or 22 (Step 5, 11, 17, or 23)

                const candidates: Array<{
                  stepIdx: number;
                  refName: string;
                  region: { minX: number; maxX: number; minY: number; maxY: number };
                }> = [
                  {
                    stepIdx: roundAsNumStepIdx,
                    refName: macro.steps[roundAsNumStepIdx]?.refPath || `as${roundIndex + 1}.png`,
                    region: {
                      minX: macro.steps[roundAsNumStepIdx]?.minX ?? 230,
                      maxX: macro.steps[roundAsNumStepIdx]?.maxX ?? 625,
                      minY: macro.steps[roundAsNumStepIdx]?.minY ?? 1622,
                      maxY: macro.steps[roundAsNumStepIdx]?.maxY ?? 1707
                    }
                  },
                  {
                    stepIdx: roundAsBtnStepIdx,
                    refName: 'asbtn.png',
                    region: { minX: 771, maxX: 840, minY: 1107, maxY: 1176 }
                  }
                ];

                let recovered = false;
                // Try on current screen first, then if none found wait 600ms and re-check once on a fresh screen
                for (let attempt = 0; attempt < 2 && !recovered; attempt++) {
                  const screenToCheck = attempt === 0 ? rawScreen : await adb.screencapRaw();
                  for (const cand of candidates) {
                    const candName = cand.refName;
                    const candIsRam = candName.startsWith('ram://');
                    const candPath = candIsRam ? candName : resolveCustomImagePath(candName);
                    const candExists = candIsRam
                      ? TemplateMatcher.hasInMemoryTemplate(candName)
                      : Boolean(candPath && fs.existsSync(candPath));
                    if (!candExists || !candPath) continue;

                    const candMatch = await TemplateMatcher.matchRaw(screenToCheck, candPath, {
                      scales: [0.7, 0.85, 1.0, 1.15, 1.3],
                      threshold: effectiveThreshold,
                      region: cand.region
                    });

                    if (candMatch.found) {
                      if (candIsRam) {
                        const tapRes = await adb.tapRandomRange(465, 602, 1109, 1223);
                        ctx.log(
                          `🔄 Found center RAM image (${(candMatch.score * 100).toFixed(1)}%)! Clicked center XY range at (${tapRes.x}, ${tapRes.y}) and continuing from step ${cand.stepIdx + 1}...`,
                          'info'
                        );
                      } else {
                        const clickX = candMatch.targetPoint.x;
                        const clickY = candMatch.targetPoint.y;
                        ctx.log(
                          `🔄 Found "${candName}" (${(candMatch.score * 100).toFixed(1)}%)! Clicking (${clickX}, ${clickY}) and continuing from step ${cand.stepIdx + 1}...`,
                          'info'
                        );
                        await adb.tap(clickX, clickY);
                        if (isStartMacro && /as[1-4]\.png/i.test(candName)) {
                          asCount++;
                        }
                      }
                      i = cand.stepIdx; // Loop will increment `i` to `cand.stepIdx + 1` (the wait step right after this button)
                      recovered = true;
                      break;
                    }
                  }

                  if (!recovered && attempt === 0) {
                    await sleep(600);
                  }
                }

                if (!recovered) {
                  // Check if this screen matches any user-configured screen rules (Zero AI)
                  if (consecutiveRescuesOnStep < 2) {
                    const ruleCheck = await screenRuleManager.checkAndExecuteRule(adb, screenPng);
                    if (ruleCheck.matched && ruleCheck.rule) {
                      lastRescuedStep = i;
                      consecutiveRescuesOnStep++;
                      const actionDesc =
                        ruleCheck.rule.action.type === 'sequence'
                          ? 'Executed sequence action'
                          : ruleCheck.rule.action.type === 'tap'
                          ? `Tapped (${ruleCheck.rule.action.x}, ${ruleCheck.rule.action.y})`
                          : ruleCheck.rule.action.type === 'back'
                          ? 'Pressed Back button'
                          : `Tapped range ${ruleCheck.rule.action.minX}-${ruleCheck.rule.action.maxX}`;
                      ctx.log(
                        `🛡️ Screen Rule Handled: Recognized "${ruleCheck.rule.id}"! ${actionDesc}. Resuming step ${stepNumber}...`,
                        'info'
                      );
                      await sleep(800);
                      i--; // Retry current step
                      continue;
                    }
                  }

                  // No rule matched: Capture FULL screen screenshot, detect text & unique info, assign ID
                  const scorePct = match.score * 100;
                  const threshPct = effectiveThreshold * 100;
                  const errorMsg = `❌ Image "${targetName}" NOT found in ${macro.name} step ${stepNumber}! Score: ${scorePct.toFixed(1)}% (< ${threshPct.toFixed(0)}%).`;
                  ctx.log(errorMsg, 'error');

                  try {
                    const webhook = botManager.getWebhookService();
                    await screenRuleManager.handleUnknownScreen(adb, webhook, ctx, {
                      macroName: macro.name,
                      stepNumber,
                      targetName
                    });
                  } catch (err: any) {
                    ctx.log(`Failed to process unknown screen: ${err.message}`, 'warn');
                  }

                  if (isStartMacro) {
                    this.saveStartState({
                      isRunning: false,
                      resumeAfterUpdate: false,
                      autoFixacEnabled,
                      currentStep: stepNumber,
                      cycleCount: loopCount,
                      totalStepsExecuted,
                      nextFixacRemainingMs: Math.max(0, nextFixacAt - Date.now()),
                      asCount,
                      acFixCount,
                      repairCount,
                      liveStatusMsgId
                    });
                    await updateLiveStatus('stopped');
                  }
                  this.notifyCycleStopped();
                  this.stopRequestedForRunId = runId;
                  return { success: false, message: errorMsg, steps: stepsLog };
                }
              } else {
                const screenPng = await TemplateMatcher.cropRawToPng(rawScreen);
                if (consecutiveRescuesOnStep < 2) {
                  const ruleCheck = await screenRuleManager.checkAndExecuteRule(adb, screenPng);
                  if (ruleCheck.matched && ruleCheck.rule) {
                    lastRescuedStep = i;
                    consecutiveRescuesOnStep++;
                    const actionDesc =
                      ruleCheck.rule.action.type === 'sequence'
                        ? 'Executed sequence action'
                        : ruleCheck.rule.action.type === 'tap'
                        ? `Tapped (${ruleCheck.rule.action.x}, ${ruleCheck.rule.action.y})`
                        : ruleCheck.rule.action.type === 'back'
                        ? 'Pressed Back button'
                        : `Tapped range ${ruleCheck.rule.action.minX}-${ruleCheck.rule.action.maxX}`;
                    ctx.log(
                      `🛡️ Screen Rule Handled: Recognized "${ruleCheck.rule.id}"! ${actionDesc}. Resuming step ${stepNumber}...`,
                      'info'
                    );
                    await sleep(800);
                    i--; // Retry current step
                    continue;
                  }
                }

                const scorePct = match.score * 100;
                const threshPct = effectiveThreshold * 100;
                const errorMsg = `❌ Image "${targetName}" NOT found in ${macro.name} step ${stepNumber}! Score: ${scorePct.toFixed(1)}% (< ${threshPct.toFixed(0)}%).`;
                ctx.log(errorMsg, 'error');

                try {
                  const webhook = botManager.getWebhookService();
                  await screenRuleManager.handleUnknownScreen(adb, webhook, ctx, {
                    macroName: macro.name,
                    stepNumber,
                    targetName
                  });
                } catch (err: any) {
                  ctx.log(`Failed to process unknown screen: ${err.message}`, 'warn');
                }

                if (isStartMacro) {
                  this.saveStartState({
                    isRunning: false,
                    resumeAfterUpdate: false,
                    currentStep: stepNumber,
                    cycleCount: loopCount,
                    totalStepsExecuted,
                    nextFixacRemainingMs: Math.max(0, nextFixacAt - Date.now()),
                    asCount,
                    acFixCount,
                    repairCount,
                    liveStatusMsgId
                  });
                  await updateLiveStatus('stopped');
                }
                this.notifyCycleStopped();
                this.stopRequestedForRunId = runId;
                return { success: false, message: errorMsg, steps: stepsLog };
              }
            } else {
              const errorMsg = `❌ Template image "${targetName}" not found on disk! Stopping macro ${macro.name}.`;
              ctx.log(errorMsg, 'error');
              try {
                const webhook = botManager.getWebhookService();
                if (webhook.isConfigured()) {
                  const croppedBuffer = await captureCleanErrorScreenshot(adb, region, rawScreen);
                  await webhook.send({
                    content: errorMsg,
                    fileBuffer: croppedBuffer,
                    fileName: `missing_file_${targetName}_step${stepNumber}.png`
                  });
                }
              } catch (err: any) {
                ctx.log(`Failed to send missing file image: ${err.message}`, 'warn');
              }

              if (isStartMacro) {
                this.saveStartState({
                  isRunning: false,
                  resumeAfterUpdate: false,
                  currentStep: stepNumber,
                  cycleCount: loopCount,
                  totalStepsExecuted,
                  nextFixacRemainingMs: Math.max(0, nextFixacAt - Date.now()),
                  asCount,
                  acFixCount,
                  repairCount,
                  liveStatusMsgId
                });
                await updateLiveStatus('stopped');
              }
              this.notifyCycleStopped();
              this.stopRequestedForRunId = runId;
              return { success: false, message: errorMsg, steps: stepsLog };
            }
            break;
          }

          case 'center_crop_webhook': {
            const rawScreen = await adb.screencapRaw();
            const w = step.cropW || 150;
            const h = step.cropH || 150;
            const cropped = await TemplateMatcher.cropRawCenterToPng(rawScreen, w, h);

            if (webhook.isConfigured()) {
              const fileName = `crop_${Date.now()}.png`;
              if (progressMsgId) {
                await webhook.edit(progressMsgId, {
                  content: `**${macro.name}** *(${w}×${h})*`,
                  fileBuffer: cropped,
                  fileName
                });
              } else {
                await webhook.send({
                  content: `**${macro.name}** *(${w}×${h})*`,
                  fileBuffer: cropped,
                  fileName
                });
              }
              sentCropImage = true;
            }
            break;
          }

          case 'swipe': {
            const sx = step.startX ?? 500;
            const sy = step.startY ?? 1500;
            await adb.tap(sx, sy);
            break;
          }

          case 'text': {
            break;
          }

          case 'key': {
            break;
          }
        }

        stepsLog.push({
          step: stepNumber,
          title,
          description: step.label || step.type,
          timestamp: Date.now(),
          status: 'completed'
        });
      } catch (err: any) {
        if (isStartMacro) {
          await updateLiveStatus('stopped');
        }
        if (this.runningMacroName === macro.name) {
          this.notifyCycleStopped();
        }
        stepsLog.push({
          step: stepNumber,
          title,
          description: err.message,
          timestamp: Date.now(),
          status: 'failed'
        });
        const failMsg = `${macro.name}: failed at step ${stepNumber} (${err.message})`;
        ctx.log(failMsg, 'error');
        if (progressMsgId) {
          await updateProgress(failMsg);
        } else if (ctx.reply) {
          await ctx.reply(failMsg);
        }
        return { success: false, message: failMsg, steps: stepsLog };
      }
    }

    if (this.runningMacroName === macro.name) {
      if (isStartMacro) {
        await updateLiveStatus('stopped');
      }
      this.notifyCycleStopped();
    }

    const successMsg = `${macro.name}: done`;
    ctx.log(`Macro "${macro.name}" finished.`, 'info');
    if (!sentCropImage) {
      if (progressMsgId) {
        await updateProgress(successMsg);
      } else if (ctx.reply) {
        await ctx.reply(successMsg);
      }
    }

    return {
      success: true,
      message: successMsg,
      steps: stepsLog
    };
  }

  private static loadMacros(): void {
    const filePath = resolveMacrosFilePath();
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const list: CustomMacro[] = JSON.parse(raw);
        for (const item of list) {
          this.macros.set(item.name.toLowerCase(), item);
        }
      } catch (err) {
        console.error('Failed to load custom macros:', err);
      }
    }

    const existingStart = this.macros.get('start');
    if (!existingStart || existingStart.steps.length !== 25) {
      const defaultStart: CustomMacro = {
        name: 'start',
        description: 'Custom macro with visual matching on asbtn.png and as1–as4.png (loops continuously)',
        createdAt: new Date().toISOString(),
        steps: [
          {
            type: 'tap_range',
            minX: 465,
            maxX: 602,
            minY: 1109,
            maxY: 1223,
            label: 'Random Tap X=[465..602], Y=[1109..1223]'
          },
          {
            type: 'wait',
            ms: 500,
            label: 'Wait 500ms'
          },
          {
            type: 'locate_and_tap',
            refPath: 'asbtn.png',
            minX: 771,
            maxX: 840,
            minY: 1107,
            maxY: 1176,
            label: 'Match asbtn.png in X=[771..840], Y=[1107..1176] & tap'
          },
          {
            type: 'wait',
            ms: 500,
            label: 'Wait 500ms'
          },
          {
            type: 'locate_and_tap',
            refPath: 'as1.png',
            minX: 230,
            maxX: 309,
            minY: 1625,
            maxY: 1704,
            label: 'Match as1.png in X=[230..309], Y=[1625..1704] & tap'
          },
          {
            type: 'wait',
            ms: 500,
            label: 'Wait 500ms'
          },
          {
            type: 'tap_range',
            minX: 465,
            maxX: 602,
            minY: 1109,
            maxY: 1223,
            label: 'Random Tap X=[465..602], Y=[1109..1223]'
          },
          {
            type: 'wait',
            ms: 500,
            label: 'Wait 500ms'
          },
          {
            type: 'locate_and_tap',
            refPath: 'asbtn.png',
            minX: 771,
            maxX: 840,
            minY: 1107,
            maxY: 1176,
            label: 'Match asbtn.png in X=[771..840], Y=[1107..1176] & tap'
          },
          {
            type: 'wait',
            ms: 500,
            label: 'Wait 500ms'
          },
          {
            type: 'locate_and_tap',
            refPath: 'as2.png',
            minX: 337,
            maxX: 416,
            minY: 1622,
            maxY: 1701,
            label: 'Match as2.png in X=[337..416], Y=[1622..1701] & tap'
          },
          {
            type: 'wait',
            ms: 500,
            label: 'Wait 500ms'
          },
          {
            type: 'tap_range',
            minX: 465,
            maxX: 602,
            minY: 1109,
            maxY: 1223,
            label: 'Random Tap X=[465..602], Y=[1109..1223]'
          },
          {
            type: 'wait',
            ms: 500,
            label: 'Wait 500ms'
          },
          {
            type: 'locate_and_tap',
            refPath: 'asbtn.png',
            minX: 771,
            maxX: 840,
            minY: 1107,
            maxY: 1176,
            label: 'Match asbtn.png in X=[771..840], Y=[1107..1176] & tap'
          },
          {
            type: 'wait',
            ms: 500,
            label: 'Wait 500ms'
          },
          {
            type: 'locate_and_tap',
            refPath: 'as3.png',
            minX: 439,
            maxX: 518,
            minY: 1628,
            maxY: 1707,
            label: 'Match as3.png in X=[439..518], Y=[1628..1707] & tap'
          },
          {
            type: 'wait',
            ms: 500,
            label: 'Wait 500ms'
          },
          {
            type: 'tap_range',
            minX: 465,
            maxX: 602,
            minY: 1109,
            maxY: 1223,
            label: 'Random Tap X=[465..602], Y=[1109..1223]'
          },
          {
            type: 'wait',
            ms: 500,
            label: 'Wait 500ms'
          },
          {
            type: 'locate_and_tap',
            refPath: 'asbtn.png',
            minX: 771,
            maxX: 840,
            minY: 1107,
            maxY: 1176,
            label: 'Match asbtn.png in X=[771..840], Y=[1107..1176] & tap'
          },
          {
            type: 'wait',
            ms: 500,
            label: 'Wait 500ms'
          },
          {
            type: 'locate_and_tap',
            refPath: 'as4.png',
            minX: 546,
            maxX: 625,
            minY: 1623,
            maxY: 1702,
            label: 'Match as4.png in X=[546..625], Y=[1623..1702] & tap'
          },
          {
            type: 'wait',
            ms: 500,
            label: 'Wait 500ms'
          },
          {
            type: 'loop',
            label: 'Loop from step 1'
          }
        ]
      };
      this.macros.set('start', defaultStart);
      this.persist();
    } else {
      let updated = false;
      for (let idx = 0; idx < existingStart.steps.length; idx++) {
        const step = existingStart.steps[idx];
        if (idx === 0 || idx === 6 || idx === 12 || idx === 18) {
          if (step.type !== 'tap_range') {
            existingStart.steps[idx] = {
              type: 'tap_range',
              minX: 465,
              maxX: 602,
              minY: 1109,
              maxY: 1223,
              label: 'Random Tap X=[465..602], Y=[1109..1223]'
            };
            updated = true;
          }
        }
        if (step.type === 'wait') {
          step.ms = 600;
          step.label = 'Wait 600ms';
          updated = true;
        }
        if (step.type === 'locate_and_tap' && step.refPath === 'asbtn.png') {
          step.minX = 771;
          step.maxX = 840;
          step.minY = 1107;
          step.maxY = 1176;
          step.label = 'Match asbtn.png in X=[771..840], Y=[1107..1176] & tap';
          updated = true;
        }
        if (
          (step.type === 'locate_and_tap' && step.refPath === 'as1.png') ||
          (step.type === 'tap_range' && step.minX === 545 && step.maxX === 621)
        ) {
          step.type = 'locate_and_tap';
          step.refPath = 'as1.png';
          step.minX = 230;
          step.maxX = 309;
          step.minY = 1625;
          step.maxY = 1704;
          step.label = 'Match as1.png in X=[230..309], Y=[1625..1704] & tap';
          updated = true;
        }
        if (
          (step.type === 'locate_and_tap' && step.refPath === 'as2.png') ||
          (step.type === 'tap_range' &&
            ((step.minX === 664 && step.maxX === 715) || (step.minX === 654 && step.maxX === 730)))
        ) {
          step.type = 'locate_and_tap';
          step.refPath = 'as2.png';
          step.minX = 337;
          step.maxX = 416;
          step.minY = 1622;
          step.maxY = 1701;
          step.label = 'Match as2.png in X=[337..416], Y=[1622..1701] & tap';
          updated = true;
        }
        if (step.type === 'locate_and_tap' && step.refPath === 'as3.png') {
          step.type = 'locate_and_tap';
          step.refPath = 'as3.png';
          step.minX = 439;
          step.maxX = 518;
          step.minY = 1628;
          step.maxY = 1707;
          step.label = 'Match as3.png in X=[439..518], Y=[1628..1707] & tap';
          updated = true;
        }
        if (step.type === 'locate_and_tap' && step.refPath === 'as4.png') {
          step.type = 'locate_and_tap';
          step.refPath = 'as4.png';
          step.minX = 546;
          step.maxX = 625;
          step.minY = 1623;
          step.maxY = 1702;
          step.label = 'Match as4.png in X=[546..625], Y=[1623..1702] & tap';
          updated = true;
        }
        if (step.type === 'wait' && step.ms === 600) {
          step.ms = 500;
          step.label = 'Wait 500ms';
          updated = true;
        }
      }
      if (updated) this.persist();
    }
  }

  private static persist(): void {
    try {
      const filePath = resolveMacrosFilePath();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const list = Array.from(this.macros.values());
      fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save custom macros:', err);
    }
  }
}
