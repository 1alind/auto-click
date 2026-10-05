import fs from 'fs';
import path from 'path';
import { Jimp } from 'jimp';
import { AdbController } from './adb';
import { WebhookService } from './webhook';
import { CommandContext } from './types';
import { recognizeLinesWithTimeout, OcrLineResult } from './commands/fixac';
import { StoragePaths } from './storagePaths';

export interface ScreenRuleActionStep {
  type: 'tap' | 'tap_range' | 'back' | 'wait';
  x?: number;
  y?: number;
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
  ms?: number;
}

export interface ScreenRuleAction {
  type: 'tap' | 'tap_range' | 'back' | 'ignore' | 'sequence';
  x?: number;
  y?: number;
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
  steps?: ScreenRuleActionStep[];
}

export interface ScreenRule {
  id: string;
  name?: string;
  keywords: string[];
  rawOcrSnippet: string;
  action: ScreenRuleAction;
  detectionRegion?: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
  timesTriggered: number;
  lastTriggeredAt?: string;
  createdAt: string;
}

export interface PendingUnknownScreen {
  id: string;
  keywords: string[];
  fullText: string;
  ocrSnippet: string;
  screenshotBuffer: Buffer;
  macroName: string;
  stepNumber: number;
  targetName: string;
  timestamp: number;
}

export class ScreenRuleManager {
  private static instance: ScreenRuleManager;
  private rules: ScreenRule[] = [];
  private storageDir: string = '';
  private jsonPath: string = '';
  private latestPendingScreen: PendingUnknownScreen | null = null;

  private constructor() {
    this.initStorage();
    this.loadRules();
  }

  public static getInstance(): ScreenRuleManager {
    if (!ScreenRuleManager.instance) {
      ScreenRuleManager.instance = new ScreenRuleManager();
    }
    return ScreenRuleManager.instance;
  }

  private initStorage(): void {
    this.storageDir = StoragePaths.getRulesDir();
    this.jsonPath = StoragePaths.getRulesPath();
  }

  public getStorageDir(): string {
    return this.storageDir;
  }

  public getRules(): ScreenRule[] {
    return [...this.rules];
  }

  public getRule(id: string): ScreenRule | undefined {
    const cleanId = id.trim().toLowerCase();
    return this.rules.find((r) => r.id.toLowerCase() === cleanId);
  }

  public getLatestPendingScreen(): PendingUnknownScreen | null {
    return this.latestPendingScreen;
  }

  private loadRules(): void {
    try {
      if (fs.existsSync(this.jsonPath)) {
        const raw = fs.readFileSync(this.jsonPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.rules = parsed;
        }
      }
    } catch (err: any) {
      console.warn('[ScreenRuleManager] Failed to load screen rules:', err.message);
      this.rules = [];
    }

    // Ensure the Launch Formation dismiss rule is configured
    const lfIndex = this.rules.findIndex((r) => r.id.toLowerCase() === 'launch_formation');
    const launchFormationRule: ScreenRule = {
      id: 'launch_formation',
      name: 'Launch Formation Dismiss',
      keywords: ['launch formation', 'launch', 'formation'],
      detectionRegion: { minX: 273, maxX: 803, minY: 90, maxY: 181 },
      rawOcrSnippet: 'Launch Formation',
      action: {
        type: 'sequence',
        steps: [
          { type: 'tap_range', minX: 36, maxX: 115, minY: 94, maxY: 173 },
          { type: 'wait', ms: 500 },
          { type: 'tap_range', minX: 465, maxX: 602, minY: 1109, maxY: 1223 },
          { type: 'wait', ms: 500 }
        ]
      },
      timesTriggered: lfIndex >= 0 ? this.rules[lfIndex].timesTriggered : 0,
      createdAt: lfIndex >= 0 ? this.rules[lfIndex].createdAt : new Date().toISOString()
    };

    if (lfIndex >= 0) {
      this.rules[lfIndex] = launchFormationRule;
    } else {
      this.rules.push(launchFormationRule);
    }
    this.saveRules();
  }

  public saveRules(): void {
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      fs.writeFileSync(this.jsonPath, JSON.stringify(this.rules, null, 2), 'utf8');
    } catch (err: any) {
      console.error('[ScreenRuleManager] Failed to save screen rules:', err.message);
    }
  }

  /**
   * Cleans OCR text and extracts meaningful keywords (3+ letters, excluding common stop words)
   */
  public extractUniqueKeywords(text: string): string[] {
    const stopWords = new Set([
      'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'were', 'been',
      'will', 'would', 'there', 'their', 'what', 'when', 'where', 'which', 'your',
      'user', 'game', 'level', 'player', 'click', 'press', 'please', 'cancel',
      'confirm', 'okay', 'ok', 'yes', 'no', 'are', 'you', 'sure', 'want'
    ]);

    const cleaned = text
      .toLowerCase()
      .replace(/[^a-z0-9_\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const words = cleaned.split(' ');
    const counts = new Map<string, number>();

    for (const w of words) {
      if (w.length < 4) continue;
      if (/^\d+$/.test(w)) continue; // skip pure numbers
      if (stopWords.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }

    // Sort by length & uniqueness, return top 4-6 keywords
    const sorted = Array.from(counts.keys()).sort((a, b) => b.length - a.length);
    return sorted.slice(0, 5);
  }

  /**
   * Generates a clean human-readable screen ID from detected keywords
   */
  public generateScreenId(keywords: string[]): string {
    if (keywords.length >= 2) {
      const slug = keywords.slice(0, 3).join('_').replace(/[^a-z0-9_]/g, '');
      return slug.length > 2 ? slug : `screen_${Date.now().toString().slice(-6)}`;
    }
    if (keywords.length === 1 && keywords[0].length >= 3) {
      return `${keywords[0]}_screen`;
    }
    return `screen_${Date.now().toString().slice(-6)}`;
  }

  /**
   * Checks current screen against all user-configured rules using local OCR.
   * If matched, immediately executes the configured action!
   */
  public async checkAndExecuteRule(
    adb: AdbController,
    screenPngBuffer?: Buffer
  ): Promise<{ matched: boolean; rule?: ScreenRule; tapResult?: any }> {
    if (this.rules.length === 0) {
      return { matched: false };
    }

    try {
      const pngBuf = screenPngBuffer || (await adb.screencap());
      const ocrRes = await recognizeLinesWithTimeout(pngBuf, 0, 0, 1, 4500);
      const fullText = (ocrRes.fullText || ocrRes.lines.map((l) => l.text).join(' ')).toLowerCase();

      for (const rule of this.rules) {
        if (!rule.keywords || rule.keywords.length === 0) continue;

        let isMatched = false;

        if (rule.detectionRegion) {
          const reg = rule.detectionRegion;
          const regionLines = ocrRes.lines.filter((l) => {
            const overlapX = l.x1 >= reg.minX && l.x0 <= reg.maxX;
            const overlapY = l.y1 >= reg.minY && l.y0 <= reg.maxY;
            return overlapX && overlapY;
          });
          const regionText = regionLines.map((l) => l.text).join(' ').toLowerCase();
          const matchedKw = rule.keywords.filter((kw) =>
            regionText.includes(kw.toLowerCase()) || fullText.includes(kw.toLowerCase())
          );
          isMatched = matchedKw.length > 0;
        } else {
          // Check how many keywords match
          const matchedKeywords = rule.keywords.filter((kw) => fullText.includes(kw.toLowerCase()));
          const matchRatio = matchedKeywords.length / rule.keywords.length;

          // Matches if at least 60% of keywords (or at least 2) are present
          isMatched =
            rule.keywords.length === 1
              ? matchedKeywords.length === 1
              : matchRatio >= 0.6 || matchedKeywords.length >= 2;
        }

        if (isMatched) {
          // Execute the user-defined action
          let tapRes: any = null;
          if (rule.action.type === 'tap' && rule.action.x !== undefined && rule.action.y !== undefined) {
            tapRes = await adb.tap(rule.action.x, rule.action.y);
          } else if (rule.action.type === 'tap_range') {
            tapRes = await adb.tapRandomRange(
              rule.action.minX ?? 0,
              rule.action.maxX ?? 100,
              rule.action.minY ?? 0,
              rule.action.maxY ?? 100
            );
          } else if (rule.action.type === 'back') {
            await adb.keyEvent(4); // Android KEYCODE_BACK
            tapRes = { back: true };
          } else if (rule.action.type === 'sequence' && rule.action.steps) {
            for (const s of rule.action.steps) {
              if (s.type === 'tap' && s.x !== undefined && s.y !== undefined) {
                tapRes = await adb.tap(s.x, s.y);
              } else if (s.type === 'tap_range') {
                tapRes = await adb.tapRandomRange(
                  s.minX ?? 0,
                  s.maxX ?? 100,
                  s.minY ?? 0,
                  s.maxY ?? 100
                );
              } else if (s.type === 'back') {
                await adb.keyEvent(4);
                tapRes = { back: true };
              } else if (s.type === 'wait') {
                await new Promise((resolve) => setTimeout(resolve, s.ms || 500));
              }
            }
          }

          rule.timesTriggered = (rule.timesTriggered || 0) + 1;
          rule.lastTriggeredAt = new Date().toISOString();
          this.saveRules();

          return {
            matched: true,
            rule,
            tapResult: tapRes
          };
        }
      }
    } catch (err: any) {
      console.warn('[ScreenRuleManager] Error checking screen rules:', err.message);
    }

    return { matched: false };
  }

  /**
   * When an unknown screen or missing image blocks a macro:
   * 1. Captures a full-screen screenshot
   * 2. Sends the failure alert and screenshot image to Discord
   */
  public async handleUnknownScreen(
    adb: AdbController,
    webhook: WebhookService,
    ctx: CommandContext,
    contextInfo: { macroName: string; stepNumber: number; targetName: string }
  ): Promise<PendingUnknownScreen> {
    const screenshot = await adb.screencap();

    const pending: PendingUnknownScreen = {
      id: `screen_${Date.now().toString().slice(-6)}`,
      keywords: [],
      fullText: '',
      ocrSnippet: '',
      screenshotBuffer: screenshot,
      macroName: contextInfo.macroName,
      stepNumber: contextInfo.stepNumber,
      targetName: contextInfo.targetName,
      timestamp: Date.now()
    };

    this.latestPendingScreen = pending;

    const msg = `❌ **Target Not Found**\n• **Macro**: \`${contextInfo.macroName}\` (Step ${contextInfo.stepNumber} looking for \`${contextInfo.targetName}\`)\n• Screenshot attached below:`;

    ctx.log(`Target not found in ${contextInfo.macroName} step ${contextInfo.stepNumber} (${contextInfo.targetName}). Sending screenshot to Discord...`, 'warn');

    if (webhook.isConfigured()) {
      await webhook.send({
        content: msg,
        fileBuffer: screenshot,
        fileName: `screen_${Date.now()}.png`
      }).catch((err) => {
        ctx.log(`Failed to upload screenshot to Discord: ${err.message}`, 'error');
      });
    } else if (ctx.reply) {
      await ctx.reply(msg);
    }

    return pending;
  }

  /**
   * Updates the suggested ID for the latest pending unknown screen
   */
  public setPendingId(newId: string): boolean {
    if (!this.latestPendingScreen) return false;
    const cleanId = newId.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!cleanId) return false;
    this.latestPendingScreen.id = cleanId;
    return true;
  }

  /**
   * Renames an existing screen rule ID and preserves all its keywords, action, and trigger count
   */
  public renameRule(oldId: string, newId: string): { success: boolean; message: string; rule?: ScreenRule } {
    const cleanOld = oldId.trim().toLowerCase();
    const cleanNew = newId.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');

    if (!cleanNew) {
      return { success: false, message: 'New Screen ID cannot be empty.' };
    }

    const rule = this.rules.find((r) => r.id.toLowerCase() === cleanOld);
    if (!rule) {
      return { success: false, message: `Screen rule \`${oldId}\` not found.` };
    }

    const collision = this.rules.find((r) => r.id.toLowerCase() === cleanNew && r !== rule);
    if (collision) {
      return { success: false, message: `A screen rule with ID \`${cleanNew}\` already exists.` };
    }

    rule.id = cleanNew;
    rule.name = cleanNew;
    this.saveRules();

    if (this.latestPendingScreen && this.latestPendingScreen.id.toLowerCase() === cleanOld) {
      this.latestPendingScreen.id = cleanNew;
    }

    return { success: true, message: `Renamed screen ID \`${cleanOld}\` to \`${cleanNew}\``, rule };
  }

  /**
   * Sets or updates a rule action for a specific screen ID
   */
  public setRule(
    id: string,
    action: ScreenRuleAction,
    options?: { keywords?: string[]; snippet?: string }
  ): ScreenRule {
    const cleanId = id.trim().toLowerCase();
    const existingIndex = this.rules.findIndex((r) => r.id.toLowerCase() === cleanId);

    const pending = this.latestPendingScreen && this.latestPendingScreen.id.toLowerCase() === cleanId
      ? this.latestPendingScreen
      : null;

    let keywords: string[] = [];
    if (Array.isArray(options?.keywords)) {
      keywords = options.keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
    } else if (typeof options?.keywords === 'string') {
      keywords = (options.keywords as string)
        .split(/[,;|]+/)
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);
    }

    if (keywords.length === 0) {
      if (pending && pending.keywords.length > 0) {
        keywords = pending.keywords;
      } else {
        keywords = cleanId
          .split(/[_-\s]+/)
          .filter((w) => w.length >= 3)
          .map((w) => w.toLowerCase());
        if (keywords.length === 0) {
          keywords = [cleanId];
        }
      }
    }

    const rawOcrSnippet = options?.snippet || (pending ? pending.ocrSnippet : cleanId);

    const rule: ScreenRule = {
      id: cleanId,
      name: cleanId,
      keywords,
      rawOcrSnippet,
      action,
      timesTriggered: existingIndex >= 0 ? this.rules[existingIndex].timesTriggered : 0,
      createdAt: existingIndex >= 0 ? this.rules[existingIndex].createdAt : new Date().toISOString()
    };

    if (existingIndex >= 0) {
      this.rules[existingIndex] = rule;
    } else {
      this.rules.push(rule);
    }

    this.saveRules();
    return rule;
  }

  public deleteRule(id: string): boolean {
    const cleanId = id.trim().toLowerCase();
    const beforeCount = this.rules.length;
    this.rules = this.rules.filter((r) => r.id.toLowerCase() !== cleanId);
    if (this.rules.length !== beforeCount) {
      this.saveRules();
      return true;
    }
    return false;
  }
}

export const screenRuleManager = ScreenRuleManager.getInstance();
