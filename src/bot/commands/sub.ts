import fs from 'fs';
import path from 'path';
import os from 'os';
import { Jimp } from 'jimp';
import { CommandDefinition, CommandContext, CommandResult, StepLog } from '../types';
import { TemplateMatcher } from '../matcher';
import { recognizeLinesWithTimeout, OcrLineResult } from './fixac';

export type SubOption = 'normal' | 'red' | 'gold';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let subRunningOption: SubOption | null = null;
let subStopRequested = false;

export function isSubRunning(): boolean {
  return subRunningOption !== null;
}

export function getRunningSubOption(): SubOption | null {
  return subRunningOption;
}

export function stopSub(): boolean {
  if (!subRunningOption) return false;
  subStopRequested = true;
  return true;
}

async function interruptibleSleep(totalMs: number): Promise<boolean> {
  const stepMs = 250;
  let elapsed = 0;
  while (elapsed < totalMs) {
    if (subStopRequested) return false;
    const wait = Math.min(stepMs, totalMs - elapsed);
    await sleep(wait);
    elapsed += wait;
  }
  return !subStopRequested;
}

function resolveAutoclickImagePath(imageName: string): string | null {
  const clean = imageName.trim();
  const homeDir = process.env.HOME || os.homedir() || '';
  const sharedDirs = [
    path.resolve(homeDir, 'storage/shared/autoclick'),
    '/sdcard/autoclick',
    '/storage/emulated/0/autoclick',
    process.cwd()
  ];

  const hasExt = /\.[a-z0-9]+$/i.test(clean);
  const fileVariants = hasExt ? [clean] : [clean, `${clean}.png`, `${clean}.jpg`, `${clean}.jpeg`];

  for (const dir of sharedDirs) {
    for (const variant of fileVariants) {
      const candidate = path.resolve(dir, variant);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function isTextPixel(r: number, g: number, b: number): boolean {
  // White / light UI text
  return r >= 165 && g >= 165 && b >= 165 && Math.abs(r - g) <= 40 && Math.abs(g - b) <= 40;
}

/**
 * Verifies the white word "Box" inside X: 132-271, Y: 231-338.
 */
async function verifyBoxWordInRegion(
  rawScreen: { data: Buffer; width: number; height: number }
): Promise<{ found: boolean; text: string }> {
  const roiX = 132;
  const roiY = 231;
  const roiW = 271 - 132;
  const roiH = 338 - 231;

  // Create 2x scaled binary image of white text in 132-271 231-338 for crisp OCR
  const out = new Jimp({ width: roiW, height: roiH, color: 0xffffffff });
  const src = rawScreen.data;
  const dst = out.bitmap.data;
  const fullW = rawScreen.width;

  let whitePixelCount = 0;
  for (let y = 0; y < roiH; y++) {
    const srcRow = (roiY + y) * fullW;
    const dstRow = y * roiW;
    for (let x = 0; x < roiW; x++) {
      const sIdx = (srcRow + (roiX + x)) * 4;
      const dIdx = (dstRow + x) * 4;
      const r = src[sIdx];
      const g = src[sIdx + 1];
      const b = src[sIdx + 2];

      const isWhite = isTextPixel(r, g, b);
      if (isWhite) whitePixelCount++;
      const v = isWhite ? 0 : 255;
      dst[dIdx] = v;
      dst[dIdx + 1] = v;
      dst[dIdx + 2] = v;
      dst[dIdx + 3] = 255;
    }
  }

  const scaled = out.resize({ w: roiW * 2, h: roiH * 2 });
  const buf = await scaled.getBuffer('image/png');
  const { fullText } = await recognizeLinesWithTimeout(buf, roiX, roiY, 2, 3500);
  const clean = fullText.toLowerCase().replace(/[^a-z0-9]/g, '');

  const matched =
    clean.includes('box') ||
    clean.includes('b0x') ||
    clean.includes('bo') ||
    clean.includes('ox') ||
    (whitePixelCount >= 45 && clean.length >= 2);

  return { found: matched, text: fullText.trim() || (matched ? 'Box' : '') };
}

async function createWhiteTextBuffer(
  rawScreen: { data: Buffer; width: number; height: number },
  roiX: number,
  roiY: number,
  roiW: number,
  roiH: number
): Promise<Buffer> {
  const out = new Jimp({ width: roiW, height: roiH, color: 0xffffffff });
  const src = rawScreen.data;
  const dst = out.bitmap.data;
  const fullW = rawScreen.width;

  for (let y = 0; y < roiH; y++) {
    const srcRow = (roiY + y) * fullW;
    const dstRow = y * roiW;
    for (let x = 0; x < roiW; x++) {
      const sIdx = (srcRow + (roiX + x)) * 4;
      const dIdx = (dstRow + x) * 4;
      const r = src[sIdx];
      const g = src[sIdx + 1];
      const b = src[sIdx + 2];

      const v = isTextPixel(r, g, b) ? 0 : 255;
      dst[dIdx] = v;
      dst[dIdx + 1] = v;
      dst[dIdx + 2] = v;
      dst[dIdx + 3] = 255;
    }
  }

  return await out.getBuffer('image/png');
}

function matchesSonobuoyText(lineText: string, option: SubOption): boolean {
  const clean = lineText.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hasSonobuoyKeyword =
    clean.includes('sonobuoy') ||
    clean.includes('sonob') ||
    clean.includes('armada') ||
    clean.includes('detection');

  if (!hasSonobuoyKeyword) return false;

  if (option === 'normal') {
    if (clean.includes('special')) return false;
    return clean.includes('normal') || clean.includes('sonobuoy') || clean.includes('detection');
  }

  // 'red' and 'gold' -> "Armada Detection Sonobuoy (Special)"
  if (clean.includes('normal')) return false;
  return clean.includes('special') || clean.includes('sonobuoy') || clean.includes('detection');
}

async function findSonobuoyTargetOnScreen(
  rawScreen: { data: Buffer; width: number; height: number },
  option: SubOption
): Promise<OcrLineResult | null> {
  const roiX = 40;
  const roiY = Math.floor(rawScreen.height * 0.14);
  const roiW = rawScreen.width - 80;
  const roiH = Math.floor(rawScreen.height * 0.78);

  const whiteLayerBuf = await createWhiteTextBuffer(rawScreen, roiX, roiY, roiW, roiH);
  const { lines: allLines } = await recognizeLinesWithTimeout(whiteLayerBuf, roiX, roiY, 1, 6000);

  const candidates = allLines.filter((l) => matchesSonobuoyText(l.text, option));
  if (candidates.length === 0) return null;

  if (option === 'normal') {
    const exactNormal = candidates.find((c) => c.text.toLowerCase().includes('normal'));
    return exactNormal || candidates[0];
  }

  const exactSpecial = candidates.filter((c) => c.text.toLowerCase().includes('special'));
  const list = exactSpecial.length > 0 ? exactSpecial : candidates;

  // If both Special rows are on screen, sort top-to-bottom
  list.sort((a, b) => a.y0 - b.y0);
  if (option === 'gold' && list.length >= 2) {
    return list[1];
  }
  return list[0];
}

export const subCommand: CommandDefinition = {
  name: 'sub',
  description: 'Runs the 12-step sub sequence in a 60s loop with one of 3 options: normal, red, or gold.',
  usage: 'sub <normal|red|gold|stop>',
  aliases: [],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const rawArg = (ctx.args[0] || '').toLowerCase().trim();

    if (rawArg === 'stop' || rawArg === 'off') {
      const wasRunning = stopSub();
      const msg = wasRunning ? 'stopping `sub` loop...' : '`sub` is not running';
      if (ctx.reply) await ctx.reply(msg);
      return { success: true, message: msg };
    }

    const option = rawArg as SubOption;
    if (option !== 'normal' && option !== 'red' && option !== 'gold') {
      const usageMsg = 'usage: `sub normal` | `sub red` | `sub gold` | `sub stop`';
      if (ctx.reply) await ctx.reply(usageMsg);
      return { success: false, message: usageMsg };
    }

    // If sub is already running, stop previous loop first
    if (subRunningOption) {
      subStopRequested = true;
      await sleep(350);
    }

    subRunningOption = option;
    subStopRequested = false;

    const { botManager } = await import('../botManager');
    const adb = botManager.getAdbController();
    const webhook = botManager.getWebhookService();
    const config = botManager.getConfig();
    const threshold = config.matchThreshold || 0.75;
    const stepsLog: StepLog[] = [];

    const targetLabel =
      option === 'normal'
        ? 'Armada Detection Sonobuoy (Normal)'
        : `Armada Detection Sonobuoy (Special) : ${option}`;

    let statusMsgId: string | null = null;
    const updateStatus = async (text: string) => {
      if (!webhook.isConfigured()) return;
      try {
        if (!statusMsgId) {
          statusMsgId = await webhook.send({ content: text, waitForId: true });
        } else {
          await webhook.editMessage(statusMsgId, { content: text });
        }
      } catch {
        // ignore webhook errors
      }
    };

    let cycle = 0;

    try {
      while (!subStopRequested) {
        cycle++;
        const cyclePrefix = `sub ${option} (cycle #${cycle})`;

        // =========================================================================
        // STEP 1 (All 3 options): Verify inventory.png in 420-489 2225-2281 & click
        // =========================================================================
        await updateStatus(`${cyclePrefix}: step 1/12 (verifying inventory.png & clicking 420-489 2225-2281)...`);

        const invPath = resolveAutoclickImagePath('inventory.png');
        if (!invPath) {
          const errMsg = '❌ sub error: `inventory.png` not found in `/sdcard/autoclick/`';
          await updateStatus(errMsg);
          if (!webhook.isConfigured() && ctx.reply) await ctx.reply(errMsg);
          return { success: false, message: errMsg, steps: stepsLog };
        }

        const step1Region = { minX: 420, maxX: 489, minY: 2225, maxY: 2281 };
        const rawScreen1 = await adb.screencapRaw();
        const screenW = rawScreen1.width || 1080;
        const screenH = rawScreen1.height || 2400;

        const invMatch = await TemplateMatcher.matchRaw(rawScreen1, invPath, {
          scales: [0.7, 0.85, 1.0, 1.15, 1.3],
          threshold,
          region: step1Region
        });

        if (!invMatch.found) {
          const errMsg = `❌ ${cyclePrefix} step 1 failed: \`inventory.png\` not found in 420-489 2225-2281 (${(invMatch.score * 100).toFixed(1)}%)`;
          ctx.log(errMsg, 'error');
          if (webhook.isConfigured()) {
            const cropBuf = await TemplateMatcher.cropRawToPng(rawScreen1, step1Region);
            await webhook.send({
              content: errMsg,
              fileBuffer: cropBuf,
              fileName: 'sub_step1_not_found.png'
            });
          } else if (ctx.reply) {
            await ctx.reply(errMsg);
          }
          return { success: false, message: errMsg, steps: stepsLog };
        }

        if (subStopRequested) break;
        const tap1 = await adb.tapRandomRange(420, 489, 2225, 2281);
        ctx.log(
          `✅ [${cyclePrefix}] Step 1: Verified inventory.png (${(invMatch.score * 100).toFixed(1)}%) & clicked (${tap1.x}, ${tap1.y})`,
          'info'
        );
        stepsLog.push({
          step: 1,
          title: 'Verify inventory.png & Tap 420-489 2225-2281',
          description: `Matched inventory.png (${(invMatch.score * 100).toFixed(1)}%) & tapped (${tap1.x}, ${tap1.y})`,
          timestamp: Date.now(),
          status: 'completed'
        });

        if (!(await interruptibleSleep(500))) break;

        // =========================================================================
        // STEP 2: Verify white word "Box" in 132-271 231-338 (do NOT click it),
        // then click 863-937 509-583
        // =========================================================================
        await updateStatus(`${cyclePrefix}: step 2/12 (verifying word "Box" in 132-271 231-338 & clicking 863-937 509-583)...`);

        const step2VerifyRegion = { minX: 132, maxX: 271, minY: 231, maxY: 338 };
        let rawScreen2 = await adb.screencapRaw();
        let boxCheck = await verifyBoxWordInRegion(rawScreen2);

        // Retry up to 2 more times (500ms apart) in case the inventory page is still animating open
        for (let retry = 0; retry < 2 && !boxCheck.found; retry++) {
          if (!(await interruptibleSleep(500))) break;
          rawScreen2 = await adb.screencapRaw();
          boxCheck = await verifyBoxWordInRegion(rawScreen2);
        }

        if (!boxCheck.found) {
          const errMsg = `❌ ${cyclePrefix} step 2 failed: word "Box" not found in 132-271 231-338 (OCR read: "${boxCheck.text || 'none'}")`;
          ctx.log(errMsg, 'error');
          if (webhook.isConfigured()) {
            const cropBuf = await TemplateMatcher.cropRawToPng(rawScreen2, step2VerifyRegion);
            await webhook.send({
              content: errMsg,
              fileBuffer: cropBuf,
              fileName: 'sub_step2_not_found.png'
            });
          } else if (ctx.reply) {
            await ctx.reply(errMsg);
          }
          return { success: false, message: errMsg, steps: stepsLog };
        }

        if (subStopRequested) break;
        const tap2 = await adb.tapRandomRange(863, 937, 509, 583);
        ctx.log(
          `✅ [${cyclePrefix}] Step 2: Verified word "${boxCheck.text}" in 132-271 231-338 & clicked (${tap2.x}, ${tap2.y}) in 863-937 509-583`,
          'info'
        );
        stepsLog.push({
          step: 2,
          title: 'Verify word "Box" (132-271 231-338) & Tap 863-937 509-583',
          description: `Verified "${boxCheck.text}" & tapped (${tap2.x}, ${tap2.y})`,
          timestamp: Date.now(),
          status: 'completed'
        });

        if (!(await interruptibleSleep(500))) break;

        // =========================================================================
        // STEP 3: Search for target Sonobuoy text depending on option & click it
        // =========================================================================
        await updateStatus(`${cyclePrefix}: step 3/12 (searching for "${targetLabel}")...`);

        const rawScreen3 = await adb.screencapRaw();
        const matchedLine = await findSonobuoyTargetOnScreen(rawScreen3, option);

        if (!matchedLine) {
          const errMsg = `❌ ${cyclePrefix} step 3 failed: text "${targetLabel}" not found on screen`;
          ctx.log(errMsg, 'error');
          await updateStatus(errMsg);
          if (!webhook.isConfigured() && ctx.reply) await ctx.reply(errMsg);
          return { success: false, message: errMsg, steps: stepsLog };
        }

        if (subStopRequested) break;
        const tap3 = await adb.tapRandomRange(
          Math.max(0, matchedLine.x0),
          Math.max(matchedLine.x0 + 10, matchedLine.x1),
          Math.max(0, matchedLine.y0),
          Math.max(matchedLine.y0 + 10, matchedLine.y1)
        );
        ctx.log(
          `✅ [${cyclePrefix}] Step 3: Found "${matchedLine.text}" & clicked (${tap3.x}, ${tap3.y})`,
          'info'
        );
        stepsLog.push({
          step: 3,
          title: `Find & Tap "${targetLabel}"`,
          description: `Found "${matchedLine.text}" & tapped (${tap3.x}, ${tap3.y})`,
          timestamp: Date.now(),
          status: 'completed'
        });

        if (!(await interruptibleSleep(500))) break;

        // =========================================================================
        // STEP 4: Verify and click 596-944 1720-1825 subuse.png
        // =========================================================================
        await updateStatus(`${cyclePrefix}: step 4/12 (verifying & clicking subuse.png in 596-944 1720-1825)...`);

        const subusePath = resolveAutoclickImagePath('subuse.png');
        if (!subusePath) {
          const errMsg = '❌ sub error: `subuse.png` not found in `/sdcard/autoclick/`';
          await updateStatus(errMsg);
          if (!webhook.isConfigured() && ctx.reply) await ctx.reply(errMsg);
          return { success: false, message: errMsg, steps: stepsLog };
        }

        const step4Region = { minX: 596, maxX: 944, minY: 1720, maxY: 1825 };
        let rawScreen4 = await adb.screencapRaw();
        let subuseMatch = await TemplateMatcher.matchRaw(rawScreen4, subusePath, {
          scales: [0.7, 0.85, 1.0, 1.15, 1.3],
          threshold,
          region: step4Region
        });

        if (!subuseMatch.found) {
          if (!(await interruptibleSleep(500))) break;
          rawScreen4 = await adb.screencapRaw();
          subuseMatch = await TemplateMatcher.matchRaw(rawScreen4, subusePath, {
            scales: [0.7, 0.85, 1.0, 1.15, 1.3],
            threshold,
            region: step4Region
          });
        }

        if (!subuseMatch.found) {
          const errMsg = `❌ ${cyclePrefix} step 4 failed: \`subuse.png\` not found in 596-944 1720-1825 (${(subuseMatch.score * 100).toFixed(1)}%)`;
          ctx.log(errMsg, 'error');
          if (webhook.isConfigured()) {
            const cropBuf = await TemplateMatcher.cropRawToPng(rawScreen4, step4Region);
            await webhook.send({
              content: errMsg,
              fileBuffer: cropBuf,
              fileName: 'sub_step4_not_found.png'
            });
          } else if (ctx.reply) {
            await ctx.reply(errMsg);
          }
          return { success: false, message: errMsg, steps: stepsLog };
        }

        if (subStopRequested) break;
        const tap4 = await adb.tapRandomRange(596, 944, 1720, 1825);
        ctx.log(
          `✅ [${cyclePrefix}] Step 4: Verified subuse.png (${(subuseMatch.score * 100).toFixed(1)}%) & clicked (${tap4.x}, ${tap4.y})`,
          'info'
        );
        stepsLog.push({
          step: 4,
          title: 'Verify & Tap subuse.png (596-944 1720-1825)',
          description: `Verified subuse.png (${(subuseMatch.score * 100).toFixed(1)}%) & tapped (${tap4.x}, ${tap4.y})`,
          timestamp: Date.now(),
          status: 'completed'
        });

        if (!(await interruptibleSleep(500))) break;

        // =========================================================================
        // STEP 5: Swipe from top to bottom inside 428-595 1253-1783
        // =========================================================================
        await updateStatus(`${cyclePrefix}: step 5/12 (swiping top-to-bottom in 428-595 1253-1783)...`);

        if (subStopRequested) break;
        const swipeX1 = Math.floor(428 + Math.random() * (595 - 428 + 1));
        const swipeY1 = Math.floor(1253 + Math.random() * 25);
        const swipeX2 = Math.floor(428 + Math.random() * (595 - 428 + 1));
        const swipeY2 = Math.floor(1758 + Math.random() * (1783 - 1758 + 1));

        await adb.swipe(swipeX1, swipeY1, swipeX2, swipeY2, 350);
        ctx.log(
          `✅ [${cyclePrefix}] Step 5: Swiped top-to-bottom (${swipeX1}, ${swipeY1}) -> (${swipeX2}, ${swipeY2}) in 428-595 1253-1783`,
          'info'
        );
        stepsLog.push({
          step: 5,
          title: 'Swipe Top-to-Bottom (428-595 1253-1783)',
          description: `Swiped (${swipeX1}, ${swipeY1}) -> (${swipeX2}, ${swipeY2})`,
          timestamp: Date.now(),
          status: 'completed'
        });

        if (!(await interruptibleSleep(500))) break;

        // =========================================================================
        // STEP 6: Click area 199-858 1669-1758
        // =========================================================================
        await updateStatus(`${cyclePrefix}: step 6/12 (clicking 199-858 1669-1758)...`);

        if (subStopRequested) break;
        const tap6 = await adb.tapRandomRange(199, 858, 1669, 1758);
        ctx.log(`✅ [${cyclePrefix}] Step 6: Clicked (${tap6.x}, ${tap6.y}) in 199-858 1669-1758`, 'info');
        stepsLog.push({
          step: 6,
          title: 'Tap 199-858 1669-1758',
          description: `Tapped (${tap6.x}, ${tap6.y})`,
          timestamp: Date.now(),
          status: 'completed'
        });

        if (!(await interruptibleSleep(500))) break;

        // =========================================================================
        // STEP 7: Click area 309-784 1845-1960
        // =========================================================================
        await updateStatus(`${cyclePrefix}: step 7/12 (clicking 309-784 1845-1960)...`);

        if (subStopRequested) break;
        const tap7 = await adb.tapRandomRange(309, 784, 1845, 1960);
        ctx.log(`✅ [${cyclePrefix}] Step 7: Clicked (${tap7.x}, ${tap7.y}) in 309-784 1845-1960`, 'info');
        stepsLog.push({
          step: 7,
          title: 'Tap 309-784 1845-1960',
          description: `Tapped (${tap7.x}, ${tap7.y})`,
          timestamp: Date.now(),
          status: 'completed'
        });

        if (!(await interruptibleSleep(500))) break;

        // =========================================================================
        // STEP 8: Click area 50-99 1870-1919
        // =========================================================================
        await updateStatus(`${cyclePrefix}: step 8/12 (clicking 50-99 1870-1919)...`);

        if (subStopRequested) break;
        const tap8 = await adb.tapRandomRange(50, 99, 1870, 1919);
        ctx.log(`✅ [${cyclePrefix}] Step 8: Clicked (${tap8.x}, ${tap8.y}) in 50-99 1870-1919`, 'info');
        stepsLog.push({
          step: 8,
          title: 'Tap 50-99 1870-1919',
          description: `Tapped (${tap8.x}, ${tap8.y})`,
          timestamp: Date.now(),
          status: 'completed'
        });

        if (!(await interruptibleSleep(500))) break;

        // =========================================================================
        // STEP 9: Click area 170-224 2010-2064
        // =========================================================================
        await updateStatus(`${cyclePrefix}: step 9/12 (clicking 170-224 2010-2064)...`);

        if (subStopRequested) break;
        const tap9 = await adb.tapRandomRange(170, 224, 2010, 2064);
        ctx.log(`✅ [${cyclePrefix}] Step 9: Clicked (${tap9.x}, ${tap9.y}) in 170-224 2010-2064`, 'info');
        stepsLog.push({
          step: 9,
          title: 'Tap 170-224 2010-2064',
          description: `Tapped (${tap9.x}, ${tap9.y})`,
          timestamp: Date.now(),
          status: 'completed'
        });

        if (!(await interruptibleSleep(500))) break;

        // =========================================================================
        // STEP 10: Click 150x150 px in middle of screen
        // =========================================================================
        const centerX = Math.floor(screenW / 2);
        const centerY = Math.floor(screenH / 2);
        const midMinX = centerX - 75;
        const midMaxX = centerX + 75;
        const midMinY = centerY - 75;
        const midMaxY = centerY + 75;

        await updateStatus(`${cyclePrefix}: step 10/12 (clicking 150x150 center ${midMinX}-${midMaxX} ${midMinY}-${midMaxY})...`);

        if (subStopRequested) break;
        const tap10 = await adb.tapRandomRange(midMinX, midMaxX, midMinY, midMaxY);
        ctx.log(
          `✅ [${cyclePrefix}] Step 10: Clicked 150x150 center (${tap10.x}, ${tap10.y}) in ${midMinX}-${midMaxX} ${midMinY}-${midMaxY}`,
          'info'
        );
        stepsLog.push({
          step: 10,
          title: `Tap 150x150 Center (${midMinX}-${midMaxX} ${midMinY}-${midMaxY})`,
          description: `Tapped (${tap10.x}, ${tap10.y})`,
          timestamp: Date.now(),
          status: 'completed'
        });

        if (!(await interruptibleSleep(500))) break;

        // =========================================================================
        // STEP 11: Click area 785-859 1135-1209
        // =========================================================================
        await updateStatus(`${cyclePrefix}: step 11/12 (clicking 785-859 1135-1209)...`);

        if (subStopRequested) break;
        const tap11 = await adb.tapRandomRange(785, 859, 1135, 1209);
        ctx.log(`✅ [${cyclePrefix}] Step 11: Clicked (${tap11.x}, ${tap11.y}) in 785-859 1135-1209`, 'info');
        stepsLog.push({
          step: 11,
          title: 'Tap 785-859 1135-1209',
          description: `Tapped (${tap11.x}, ${tap11.y})`,
          timestamp: Date.now(),
          status: 'completed'
        });

        if (!(await interruptibleSleep(500))) break;

        // =========================================================================
        // STEP 12: Click area 180-455 1152-1241
        // =========================================================================
        await updateStatus(`${cyclePrefix}: step 12/12 (clicking 180-455 1152-1241)...`);

        if (subStopRequested) break;
        const tap12 = await adb.tapRandomRange(180, 455, 1152, 1241);
        ctx.log(`✅ [${cyclePrefix}] Step 12: Clicked (${tap12.x}, ${tap12.y}) in 180-455 1152-1241`, 'info');
        stepsLog.push({
          step: 12,
          title: 'Tap 180-455 1152-1241',
          description: `Tapped (${tap12.x}, ${tap12.y})`,
          timestamp: Date.now(),
          status: 'completed'
        });

        // =========================================================================
        // WAIT 60 SECONDS AND START AGAIN
        // =========================================================================
        await updateStatus(
          `✅ ${cyclePrefix} completed! Waiting 60s before cycle #${cycle + 1} (send \`stop\` to stop)...`
        );
        ctx.log(`⏳ [${cyclePrefix}] Completed all 12 steps. Waiting 60 seconds before next cycle...`, 'info');

        if (!(await interruptibleSleep(60000))) break;
      }

      const stoppedMsg = `🛑 \`sub ${option}\` stopped after ${cycle} cycle(s)`;
      await updateStatus(stoppedMsg);
      if (!webhook.isConfigured() && ctx.reply) await ctx.reply(stoppedMsg);

      return {
        success: true,
        message: stoppedMsg,
        steps: stepsLog,
        data: { option, cyclesCompleted: cycle }
      };
    } catch (err: any) {
      const errMsg = `sub ${option} failed: ${err.message}`;
      ctx.log(errMsg, 'error');
      await updateStatus(errMsg);
      if (!webhook.isConfigured() && ctx.reply) await ctx.reply(errMsg);
      return {
        success: false,
        message: errMsg,
        steps: stepsLog
      };
    } finally {
      subRunningOption = null;
      subStopRequested = false;
    }
  }
};
