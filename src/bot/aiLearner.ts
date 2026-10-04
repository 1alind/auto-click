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
}

export class AiLearner {
  private static instance: AiLearner;
  private learnedPrompts: LearnedPrompt[] = [];
  private storageDir: string = '';
  private jsonPath: string = '';
  private initialized = false;

  private constructor() {
    this.initStorage();
    this.loadLearnedPrompts();
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
          return;
        } catch {}
      }
    }

    // Fallback to local cwd
    this.storageDir = path.resolve(process.cwd(), 'data/learned_prompts');
    fs.mkdirSync(this.storageDir, { recursive: true });
    this.jsonPath = path.join(this.storageDir, 'learned_prompts.json');
  }

  public getStorageDir(): string {
    return this.storageDir;
  }

  public getLearnedPrompts(): LearnedPrompt[] {
    return [...this.learnedPrompts];
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
   * If Gemini spots a popup/prompt and coordinates, it clicks it, crops the signature,
   * and saves it to the sdcard so future occurrences are handled 100% offline!
   */
  public async rescueWithGeminiAndLearn(
    adb: AdbController,
    options?: { customApiKey?: string; log?: (msg: string, level?: any) => void }
  ): Promise<{
    success: boolean;
    promptDetected: boolean;
    name?: string;
    description?: string;
    clickCoords?: { x: number; y: number };
    savedTemplatePath?: string;
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

      log(`🧠 Asking Gemini 3.8 Flash to analyze unexpected prompts (${screenW}x${screenH})...`, 'info');

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });

      const promptText = `You are an expert autonomous Android gamer and automation agent.
Look at this game screenshot.
An unexpected dialog, modal popup, daily login reward, announcement, rate us dialog, reconnect prompt, network error, or confirmation prompt might be blocking normal gameplay.

Please analyze the image:
1. Is an unexpected dialog, prompt, modal, or overlay currently visible?
2. If YES:
   - Identify what it is (name and description).
   - Find the best button to dismiss, close, or accept it (e.g. 'X' close icon, 'Claim', 'OK', 'Confirm', 'Cancel', 'Close', 'Tap to continue').
   - Return the exact pixel coordinate (clickX, clickY) to tap that button.
   - Return a small signature crop bounding box (minX, maxX, minY, maxY) around a distinct identifying visual part (like the prompt title banner, icon, or unique button) so we can save it to the sdcard and recognize it automatically in the future.
Screen dimensions are ${screenW}x${screenH}. Ensure coordinates are strictly within bounds.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
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
          message: 'Gemini analyzed the screen: no unexpected prompt or modal is blocking the screen.'
        };
      }

      const clickX = Math.max(0, Math.min(screenW - 1, Number(parsed.clickX) || 0));
      const clickY = Math.max(0, Math.min(screenH - 1, Number(parsed.clickY) || 0));
      const name = (parsed.promptName || 'unknown_prompt').toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const desc = parsed.description || name;

      // Tap the button to dismiss the prompt!
      log(`🎯 Gemini identified "${name}"! Tapping (${clickX}, ${clickY}) to resolve...`, 'info');
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
        lastUsedAt: new Date().toISOString()
      };

      this.learnedPrompts.push(learnedEntry);
      this.saveLearnedPrompts();

      log(
        `💾 Successfully learned "${name}"! Saved template to ${imageFileName} in ${this.storageDir}. Future prompts will be handled offline without AI!`,
        'info'
      );

      return {
        success: true,
        promptDetected: true,
        name,
        description: desc,
        clickCoords: { x: clickX, y: clickY },
        savedTemplatePath: savedPath,
        message: `Successfully resolved "${name}" at (${clickX}, ${clickY}) and saved to sdcard for future offline reuse!`
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
