import fs from 'fs';
import path from 'path';
import os from 'os';
import { Jimp } from 'jimp';
import { GoogleGenAI, Type } from '@google/genai';
import { AdbController } from './adb';
import { TemplateMatcher } from './matcher';

export interface LearnedPrompt {
  id: string;
  name: string;
  description: string;
  action: string;
  clickX: number;
  clickY: number;
  imageFile: string;
  cropRegion: { minX: number; maxX: number; minY: number; maxY: number };
  learnedAt: string;
  timesUsed: number;
  lastUsedAt?: string;
  gamePackage?: string;
}

export interface ModelStatusEntry {
  status: 'available' | 'high_demand';
  lastFailedAt: string;
  blacklistedUntil: number; // timestamp in ms
  failureCount: number;
  lastError: string;
}

export class AiLearner {
  private static instance: AiLearner;
  private learnedPrompts: LearnedPrompt[] = [];
  private modelStatuses: Record<string, ModelStatusEntry> = {};
  private storageDir: string = '';
  private jsonPath: string = '';
  private modelStatusPath: string = '';

  private constructor() {
    this.initStorage();
    this.loadLearnedPrompts();
    this.loadModelStatuses();
  }

  public static getInstance(): AiLearner {
    if (!AiLearner.instance) {
      AiLearner.instance = new AiLearner();
    }
    return AiLearner.instance;
  }

  /**
   * Resolves storage location on sdcard or shared storage
   */
  private initStorage(): void {
    const homeDir = process.env.HOME || os.homedir() || '';
    const candidateDirs = [
      path.resolve(homeDir, 'storage/shared/autoclick/learned_prompts'),
      '/sdcard/autoclick/learned_prompts',
      '/storage/emulated/0/autoclick/learned_prompts',
      path.resolve(process.cwd(), 'data/learned_prompts')
    ];

    for (const dir of candidateDirs) {
      const parent = path.dirname(dir);
      if (fs.existsSync(parent) || fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          this.storageDir = dir;
          this.jsonPath = path.join(dir, 'learned_prompts.json');
          this.modelStatusPath = path.join(dir, 'model_status.json');
          return;
        } catch {}
      }
    }

    // Fallback to local cwd
    this.storageDir = path.resolve(process.cwd(), 'data/learned_prompts');
    fs.mkdirSync(this.storageDir, { recursive: true });
    this.jsonPath = path.join(this.storageDir, 'learned_prompts.json');
    this.modelStatusPath = path.join(this.storageDir, 'model_status.json');
  }

  public getStorageDir(): string {
    return this.storageDir;
  }

  public getLearnedPrompts(): LearnedPrompt[] {
    return [...this.learnedPrompts];
  }

  public getModelStatuses(): Record<string, ModelStatusEntry> {
    this.loadModelStatuses();
    return { ...this.modelStatuses };
  }

  private loadLearnedPrompts(): void {
    try {
      if (fs.existsSync(this.jsonPath)) {
        const raw = fs.readFileSync(this.jsonPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.learnedPrompts = parsed;
        }
      }
    } catch (err: any) {
      console.warn('[AiLearner] Failed to load learned prompts:', err.message);
      this.learnedPrompts = [];
    }
  }

  private saveLearnedPrompts(): void {
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      fs.writeFileSync(this.jsonPath, JSON.stringify(this.learnedPrompts, null, 2), 'utf8');
    } catch (err: any) {
      console.error('[AiLearner] Failed to save learned prompts:', err.message);
    }
  }

  /**
   * Loads high-demand model cache from SD card
   */
  private loadModelStatuses(): void {
    try {
      if (fs.existsSync(this.modelStatusPath)) {
        const raw = fs.readFileSync(this.modelStatusPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.modelStatuses = parsed;
        }
      }
    } catch {
      this.modelStatuses = {};
    }
  }

  /**
   * Persists high-demand model cache to SD card
   */
  private saveModelStatuses(): void {
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      fs.writeFileSync(this.modelStatusPath, JSON.stringify(this.modelStatuses, null, 2), 'utf8');
    } catch (err: any) {
      console.error('[AiLearner] Failed to save model statuses:', err.message);
    }
  }

  /**
   * Records a model as overloaded / high-demand in SD card memory with a 45-minute cooldown.
   */
  public recordModelHighDemand(modelName: string, errorMsg: string): void {
    this.loadModelStatuses();
    const existing = this.modelStatuses[modelName] || { failureCount: 0 };
    const failureCount = (existing.failureCount || 0) + 1;
    // 45 minute cooldown to give Google servers time to recover
    const cooldownMs = 45 * 60 * 1000;

    this.modelStatuses[modelName] = {
      status: 'high_demand',
      lastFailedAt: new Date().toISOString(),
      blacklistedUntil: Date.now() + cooldownMs,
      failureCount,
      lastError: errorMsg
    };

    this.saveModelStatuses();
  }

  /**
   * Clears a model's high-demand status (e.g. if it succeeded or user resets)
   */
  public markModelSuccess(modelName: string): void {
    if (this.modelStatuses[modelName]) {
      delete this.modelStatuses[modelName];
      this.saveModelStatuses();
    }
  }

  /**
   * Checks if a model is currently blacklisted for high demand
   */
  public isModelHighDemand(modelName: string): boolean {
    this.loadModelStatuses();
    const entry = this.modelStatuses[modelName];
    if (!entry) return false;
    if (Date.now() > (entry.blacklistedUntil || 0)) {
      // Cooldown expired!
      delete this.modelStatuses[modelName];
      this.saveModelStatuses();
      return false;
    }
    return true;
  }

  /**
   * Returns list of candidate models, skipping any high-demand models recorded on the SD card,
   * prioritizing ultra-reliable lower models.
   */
  public getCandidateModels(preferredModel?: string): {
    orderedModels: string[];
    skippedHighDemand: string[];
  } {
    this.loadModelStatuses();

    // Standard list of models from lower/light to latest
    const baseCandidates = [
      preferredModel,
      'gemini-3.1-flash-lite', // lower, ultra-high throughput, almost never overloaded
      'gemini-flash-latest',   // production Flash
      'gemini-3.8-flash'       // peak model
    ].filter(Boolean) as string[];

    const unique = Array.from(new Set(baseCandidates));
    const active: string[] = [];
    const skipped: string[] = [];

    for (const m of unique) {
      if (this.isModelHighDemand(m)) {
        skipped.push(m);
      } else {
        active.push(m);
      }
    }

    // If all models are currently flagged as high demand, fallback to 'gemini-3.1-flash-lite'
    if (active.length === 0) {
      active.push('gemini-3.1-flash-lite');
    }

    return { orderedModels: active, skippedHighDemand: skipped };
  }

  /**
   * STEP 1 (Offline Memory Check):
   * Tests the current screen against all locally saved learned prompts on the sdcard.
   * If a match is found, taps the saved coordinates immediately without making any AI calls!
   */
  public async checkAndExecuteLearnedPrompt(
    adb: AdbController,
    screenPngBuffer?: Buffer
  ): Promise<{ found: boolean; prompt?: LearnedPrompt; tapResult?: any }> {
    if (this.learnedPrompts.length === 0) {
      return { found: false };
    }

    try {
      const pngBuf = screenPngBuffer || (await adb.screencap());

      for (const prompt of this.learnedPrompts) {
        const imgPath = path.join(this.storageDir, prompt.imageFile);
        if (!fs.existsSync(imgPath)) continue;

        const match = await TemplateMatcher.match(pngBuf, imgPath, {
          threshold: 0.78,
          scales: [0.9, 1.0, 1.1],
          region: prompt.cropRegion
        });

        if (match.found) {
          // Found local learned prompt! Tap the learned coordinates
          const tapRes = await adb.tap(prompt.clickX, prompt.clickY);
          prompt.timesUsed = (prompt.timesUsed || 0) + 1;
          prompt.lastUsedAt = new Date().toISOString();
          this.saveLearnedPrompts();

          return {
            found: true,
            prompt,
            tapResult: tapRes
          };
        }
      }
    } catch (err: any) {
      console.warn('[AiLearner] Error checking learned prompts:', err.message);
    }

    return { found: false };
  }

  /**
   * STEP 2 (Gemini AI Vision):
   * When no locally learned prompt matches, sends screenshot to Gemini Flash Vision.
   * - Includes current Game Name (auto-detected via ADB or user config)
   * - Includes what the bot was doing (current step/action)
   * - Checks SD card memory to bypass high-demand models and auto-uses lower models
   * - If Gemini resolves, taps the button, crops the signature, and saves it to SD card!
   */
  public async rescueWithGeminiAndLearn(
    adb: AdbController,
    options?: {
      customApiKey?: string;
      customModel?: string;
      gameName?: string;
      currentAction?: string;
      log?: (msg: string, level?: any) => void;
    }
  ): Promise<{
    success: boolean;
    promptDetected: boolean;
    name?: string;
    description?: string;
    clickCoords?: { x: number; y: number };
    savedTemplatePath?: string;
    modelUsed?: string;
    message: string;
  }> {
    const apiKey = options?.customApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return {
        success: false,
        promptDetected: false,
        message: 'No GEMINI_API_KEY configured. Please set GEMINI_API_KEY to enable AI prompt learning.'
      };
    }

    const log = options?.log || console.log;

    try {
      log('📸 Capturing clean screen for Gemini AI vision analysis...', 'info');
      const screenPng = await adb.screencap();
      const base64Screen = screenPng.toString('base64');

      const screenImg = await Jimp.read(screenPng);
      const screenW = screenImg.bitmap.width;
      const screenH = screenImg.bitmap.height;

      // 1. Context: Detect active game and action
      let activeGame = options?.gameName || '';
      if (!activeGame) {
        activeGame = await adb.getForegroundApp().catch(() => '');
      }

      const isGunshipBattle =
        !activeGame ||
        activeGame.includes('joycity') ||
        activeGame.includes('gw') ||
        activeGame.toLowerCase().includes('gunship');

      const gameDisplay = isGunshipBattle
        ? 'Gunship Battle: Total Warfare (Joycity - com.joycity.gw)'
        : (activeGame || 'Gunship Battle: Total Warfare');

      const actionDisplay =
        options?.currentAction ||
        'Automated Naval & Air Strike: Auto air-striking the Royal Armada Base with carrier jet squadrons';

      log(`🎮 Game context: "${gameDisplay}" | Action: "${actionDisplay}"`, 'info');

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });

      const promptText = `You are an expert autonomous Android gamer and automation agent.
CONTEXT:
- Target Game/App: "${gameDisplay}"
- Script Objective: "${actionDisplay}"
- Situation: The bot is automating this game, but is currently stuck or blocked because an unexpected dialog, modal popup, daily login reward, announcement, rate us dialog, reconnect prompt, network error, or confirmation is on screen.

GAME-SPECIFIC KNOWLEDGE FOR GUNSHIP BATTLE: TOTAL WARFARE:
- The bot is continuously executing air strikes against Royal Armada Bases using carrier jet squadrons.
- Common blockers to resolve:
  1. Event, Special Offer, or Daily Supply popup: Look for the small 'X' (close) icon (often top-right or top-left) or 'Close'/'Cancel' at the bottom.
  2. Armada Base Destroyed / Target Moved / Target Out of Range: Tap 'Confirm' or 'OK' to dismiss the modal and return to sea view.
  3. Battle Report / Victory / Defeat / Armada Durability Depleted: Tap 'Confirm', 'OK', or 'Tap to continue'.
  4. Jet Repair / Durability / Sortie prompt: Tap 'Repair All', 'Confirm', or 'Close'.
  5. Network Reconnect / Server Timeout: Tap 'Retry', 'Reconnect', or 'OK'.
  6. Alliance Help / Rally alert: Tap 'Help' or 'Confirm' or 'X'.
- SAFETY RULE: Never tap purchase buttons that cost real money or gold. Always prefer 'Close', 'X', 'Cancel', 'Confirm', or 'Claim Free'.

TASK:
1. Examine this screenshot carefully in the context of "${gameDisplay}".
2. Is an unexpected dialog, prompt, modal, or overlay currently visible?
3. If YES:
   - Identify what it is (name and description).
   - Find the exact button to dismiss, close, or accept it (e.g. 'X' close icon, 'Claim', 'OK', 'Confirm', 'Cancel', 'Close', 'Tap to continue').
   - Return the exact pixel coordinate (clickX, clickY) to tap that button.
   - Return a small signature crop bounding box (minX, maxX, minY, maxY) around a distinct identifying visual part (like the prompt title banner, icon, or unique button) so we can save it to the sdcard and recognize it automatically in the future without asking AI.
Screen dimensions are ${screenW}x${screenH}. Ensure coordinates are strictly within bounds.`;

      // 2. Query SD card memory for high demand models & auto-pick available lower models
      const { orderedModels, skippedHighDemand } = this.getCandidateModels(options?.customModel);

      if (skippedHighDemand.length > 0) {
        log(
          `💾 Skipped high-demand models saved on SD card: [${skippedHighDemand.join(', ')}]. Auto-trying lower model...`,
          'info'
        );
      }

      let response: any = null;
      let lastError: Error | null = null;
      let successfulModel = '';

      for (const modelName of orderedModels) {
        try {
          log(`🧠 Asking Gemini (${modelName}) to analyze unexpected prompts (${screenW}x${screenH})...`, 'info');
          response = await ai.models.generateContent({
            model: modelName,
            contents: [
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: base64Screen
                }
              },
              {
                text: promptText
              }
            ],
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  promptDetected: {
                    type: Type.BOOLEAN,
                    description: 'True if an unexpected prompt, modal, or popup is visible.'
                  },
                  promptName: {
                    type: Type.STRING,
                    description: 'Short clean identifier for the prompt, e.g. "daily_reward" or "reconnect_dialog".'
                  },
                  description: {
                    type: Type.STRING,
                    description: 'Detailed description of the prompt.'
                  },
                  action: {
                    type: Type.STRING,
                    description: 'Action to take, e.g. "tap", "dismiss", "claim".'
                  },
                  clickX: {
                    type: Type.INTEGER,
                    description: 'Exact X pixel coordinate to tap.'
                  },
                  clickY: {
                    type: Type.INTEGER,
                    description: 'Exact Y pixel coordinate to tap.'
                  },
                  signatureCrop: {
                    type: Type.OBJECT,
                    description: 'Bounding box of the signature image to crop and remember on the sdcard.',
                    properties: {
                      minX: { type: Type.INTEGER },
                      maxX: { type: Type.INTEGER },
                      minY: { type: Type.INTEGER },
                      maxY: { type: Type.INTEGER }
                    },
                    required: ['minX', 'maxX', 'minY', 'maxY']
                  }
                },
                required: ['promptDetected', 'promptName', 'action', 'clickX', 'clickY']
              }
            }
          });
          successfulModel = modelName;
          this.markModelSuccess(modelName);
          break; // Model responded successfully!
        } catch (err: any) {
          lastError = err;
          const errMsg = err.message || String(err);
          const isHighDemand =
            errMsg.includes('503') ||
            errMsg.includes('overloaded') ||
            errMsg.includes('demand') ||
            errMsg.includes('ResourceExhausted') ||
            errMsg.includes('quota');

          if (isHighDemand) {
            this.recordModelHighDemand(modelName, errMsg);
            log(
              `💾 Model "${modelName}" is in high demand! Saved to SD card (will skip on future runs). Trying lower model...`,
              'warn'
            );
          } else {
            log(`⚠️ Model "${modelName}" failed (${errMsg}). Trying lower model...`, 'warn');
          }
        }
      }

      if (!response) {
        return {
          success: false,
          promptDetected: false,
          message: `All Gemini models failed or busy: ${lastError?.message || 'High demand'}`
        };
      }

      const rawJson = response.text?.trim() || '{}';
      let parsed: any = {};
      try {
        parsed = JSON.parse(rawJson);
      } catch (err: any) {
        return {
          success: false,
          promptDetected: false,
          message: `Failed to parse Gemini JSON response: ${err.message}`
        };
      }

      if (!parsed.promptDetected) {
        return {
          success: true,
          promptDetected: false,
          modelUsed: successfulModel,
          message: `Gemini (${successfulModel}) analyzed ${gameDisplay}: no unexpected prompt is blocking the screen.`
        };
      }

      const clickX = Math.max(0, Math.min(screenW - 1, Number(parsed.clickX) || 0));
      const clickY = Math.max(0, Math.min(screenH - 1, Number(parsed.clickY) || 0));
      const name = (parsed.promptName || 'unknown_prompt').toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const desc = parsed.description || name;

      // Tap the button to dismiss the prompt!
      log(`🎯 Gemini identified "${name}" in ${gameDisplay}! Tapping (${clickX}, ${clickY}) to resolve...`, 'info');
      await adb.tap(clickX, clickY);

      // Now save to sdcard so in the future we NEVER ask the AI again!
      let savedPath = '';
      const promptId = `${name}_${Date.now()}`;
      const imageFileName = `${promptId}.png`;
      const fullImagePath = path.join(this.storageDir, imageFileName);

      // Crop the signature region
      const rawCrop = parsed.signatureCrop || {
        minX: Math.max(0, clickX - 60),
        maxX: Math.min(screenW, clickX + 60),
        minY: Math.max(0, clickY - 60),
        maxY: Math.min(screenH, clickY + 60)
      };

      const cropX = Math.max(0, Math.min(rawCrop.minX, screenW - 1));
      const cropY = Math.max(0, Math.min(rawCrop.minY, screenH - 1));
      const cropW = Math.max(10, Math.min(rawCrop.maxX - cropX, screenW - cropX));
      const cropH = Math.max(10, Math.min(rawCrop.maxY - cropY, screenH - cropY));

      const croppedImg = screenImg.clone();
      croppedImg.crop({ x: cropX, y: cropY, w: cropW, h: cropH });
      const cropBuf = await croppedImg.getBuffer('image/png');
      fs.writeFileSync(fullImagePath, cropBuf);
      savedPath = fullImagePath;

      // Save learned prompt entry
      const learnedEntry: LearnedPrompt = {
        id: promptId,
        name,
        description: desc,
        action: parsed.action || 'tap',
        clickX,
        clickY,
        imageFile: imageFileName,
        cropRegion: {
          minX: cropX,
          maxX: cropX + cropW,
          minY: cropY,
          maxY: cropY + cropH
        },
        learnedAt: new Date().toISOString(),
        timesUsed: 1,
        lastUsedAt: new Date().toISOString(),
        gamePackage: activeGame
      };

      this.learnedPrompts.push(learnedEntry);
      this.saveLearnedPrompts();

      log(
        `💾 Successfully learned "${name}"! Saved template to ${imageFileName} on SD card. Future occurrences will be resolved offline!`,
        'info'
      );

      return {
        success: true,
        promptDetected: true,
        name,
        description: desc,
        clickCoords: { x: clickX, y: clickY },
        savedTemplatePath: savedPath,
        modelUsed: successfulModel,
        message: `Successfully resolved "${name}" at (${clickX}, ${clickY}) via ${successfulModel} and saved to SD card!`
      };
    } catch (err: any) {
      return {
        success: false,
        promptDetected: false,
        message: `Gemini AI rescue failed: ${err.message}`
      };
    }
  }

  public forgetPrompt(idOrName: string): boolean {
    const idx = this.learnedPrompts.findIndex(
      (p) => p.id === idOrName || p.name.toLowerCase() === idOrName.toLowerCase()
    );
    if (idx !== -1) {
      const removed = this.learnedPrompts.splice(idx, 1)[0];
      try {
        const file = path.join(this.storageDir, removed.imageFile);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {}
      this.saveLearnedPrompts();
      return true;
    }
    return false;
  }
}

export const aiLearner = AiLearner.getInstance();
