import { Jimp } from 'jimp';
import { CommandDefinition, CommandContext, CommandResult } from '../types';
import { TemplateMatcher } from '../matcher';
import { resolveAutoclickImagePath, recognizeLinesWithTimeout } from './fixac';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let activeAcPollId = 0;

// Multi-scale range covering 0.55x (heavily zoomed out) to 1.70x (heavily zoomed in)
const WIDE_ZOOM_SCALES = [0.55, 0.65, 0.75, 0.85, 0.95, 1.0, 1.08, 1.20, 1.35, 1.50, 1.70];

/**
 * Searches for a template image with multi-scale zoom resilience.
 * First tests the expanded expected region; if not found, falls back to full-screen search.
 */
async function matchWithZoomResilience(
  rawScreen: any,
  imagePath: string,
  preferredRegion?: { minX: number; maxX: number; minY: number; maxY: number },
  threshold = 0.65
) {
  if (preferredRegion) {
    // 1. Try with expanded margin around preferred region
    const marginX = 80;
    const marginY = 80;
    const expandedRegion = {
      minX: Math.max(0, preferredRegion.minX - marginX),
      maxX: preferredRegion.maxX + marginX,
      minY: Math.max(0, preferredRegion.minY - marginY),
      maxY: preferredRegion.maxY + marginY
    };

    const match = await TemplateMatcher.matchRaw(rawScreen, imagePath, {
      region: expandedRegion,
      threshold,
      scales: WIDE_ZOOM_SCALES
    });

    if (match.found) return match;
  }

  // 2. Full-screen fallback search across all zoom scales
  return await TemplateMatcher.matchRaw(rawScreen, imagePath, {
    threshold: Math.max(0.60, threshold - 0.03),
    scales: WIDE_ZOOM_SCALES
  });
}

/**
 * Captures screenshot and sends to Discord whenever AC move gets stuck.
 */
async function sendFailureScreenshot(
  adb: any,
  webhook: any,
  ctx: CommandContext,
  stepNum: number,
  reason: string
): Promise<void> {
  try {
    const screenshot = await adb.screencap();
    const msg = `❌ AC move stuck at step ${stepNum}: ${reason}`;
    ctx.log(msg, 'error');
    if (webhook.isConfigured()) {
      await webhook.send({
        content: msg,
        fileBuffer: screenshot,
        fileName: `ac_move_stuck_step${stepNum}_${Date.now()}.png`
      });
    } else if (ctx.reply) {
      await ctx.reply(msg);
    }
  } catch (err: any) {
    ctx.log(`Failed to capture/send failure screenshot: ${err.message}`, 'error');
  }
}

/**
 * Searches for specific text in a region using OCR.
 */
async function checkTextInRegion(
  adb: any,
  region: { minX: number; maxX: number; minY: number; maxY: number },
  targetWord: string | RegExp
): Promise<{ found: boolean; text: string }> {
  try {
    const screenPng = await adb.screencap();
    const screenImg = await Jimp.read(screenPng);
    const screenW = screenImg.bitmap.width;
    const screenH = screenImg.bitmap.height;

    const cropX = Math.max(0, region.minX);
    const cropY = Math.max(0, region.minY);
    const cropW = Math.max(10, Math.min(region.maxX - cropX, screenW - cropX));
    const cropH = Math.max(10, Math.min(region.maxY - cropY, screenH - cropY));

    const cropped = screenImg.clone().crop({ x: cropX, y: cropY, w: cropW, h: cropH });
    cropped.resize({ w: cropW * 2, h: cropH * 2 });
    const cropBuf = await cropped.getBuffer('image/png');

    const ocrRes = await recognizeLinesWithTimeout(cropBuf, cropX, cropY, 2, 4000);
    const fullText = (ocrRes.fullText || ocrRes.lines.map((l) => l.text).join(' ')).trim();

    const isMatch = typeof targetWord === 'string'
      ? new RegExp(`\\b${targetWord}\\b`, 'i').test(fullText) || fullText.toLowerCase().includes(targetWord.toLowerCase())
      : targetWord.test(fullText);

    return { found: isMatch, text: fullText };
  } catch {
    return { found: false, text: '' };
  }
}

/**
 * Searches for text across full screen or region, returning target center point.
 */
async function findAndClickText(
  adb: any,
  textToFind: string | RegExp,
  region?: { minX: number; maxX: number; minY: number; maxY: number }
): Promise<{ found: boolean; point?: { x: number; y: number }; text?: string; line?: any }> {
  try {
    const screenPng = await adb.screencap();
    const screenImg = await Jimp.read(screenPng);
    const screenW = screenImg.bitmap.width;
    const screenH = screenImg.bitmap.height;

    const cropX = region ? Math.max(0, region.minX) : 0;
    const cropY = region ? Math.max(0, region.minY) : 0;
    const cropW = region ? Math.min(region.maxX - cropX, screenW - cropX) : screenW;
    const cropH = region ? Math.min(region.maxY - cropY, screenH - cropY) : screenH;

    const cropped = screenImg.clone().crop({ x: cropX, y: cropY, w: cropW, h: cropH });
    cropped.resize({ w: cropW * 2, h: cropH * 2 });
    const cropBuf = await cropped.getBuffer('image/png');

    const ocrRes = await recognizeLinesWithTimeout(cropBuf, cropX, cropY, 2, 5000);
    const regex = typeof textToFind === 'string' ? new RegExp(textToFind, 'i') : textToFind;

    const matchedLine = ocrRes.lines.find((l) => regex.test(l.text));
    if (matchedLine) {
      const targetX = Math.floor((matchedLine.x0 + matchedLine.x1) / 2);
      const targetY = Math.floor((matchedLine.y0 + matchedLine.y1) / 2);
      return { found: true, point: { x: targetX, y: targetY }, text: matchedLine.text, line: matchedLine };
    }
    return { found: false };
  } catch {
    return { found: false };
  }
}

/**
 * Checks if travel timer digits/text exist in area 8-143 1832-1966.
 * Uses an expanded crop window to reliably handle all zoom levels and button resizing.
 */
async function checkTimerExistsInRegion(adb: any): Promise<{ exists: boolean; text: string }> {
  try {
    const screenPng = await adb.screencap();
    const screenImg = await Jimp.read(screenPng);
    const screenW = screenImg.bitmap.width;
    const screenH = screenImg.bitmap.height;

    // Generous crop area around 0-260 1750-2050 to handle all zoom levels and button resizing
    const cropX = Math.max(0, 0);
    const cropY = Math.max(0, 1750);
    const cropW = Math.min(280, screenW - cropX);
    const cropH = Math.min(320, screenH - cropY);

    const cropped = screenImg.clone().crop({ x: cropX, y: cropY, w: cropW, h: cropH });
    cropped.resize({ w: cropW * 2, h: cropH * 2 });
    const cropBuf = await cropped.getBuffer('image/png');

    const ocrRes = await recognizeLinesWithTimeout(cropBuf, cropX, cropY, 2, 5000);
    const text = (ocrRes.fullText || ocrRes.lines.map((l) => l.text).join(' ')).trim();

    // Check if it contains digits / timer markers (e.g. 04:30, 4:30, 00:45, or numbers)
    const hasTimer = /\d{1,2}[:;]\d{2}/.test(text) || /\d+m|\d+s/i.test(text) || /\d{2,}/.test(text);
    return { exists: hasTimer, text };
  } catch {
    return { exists: false, text: '' };
  }
}

export const moveCommand: CommandDefinition = {
  name: 'move',
  description: 'Automates moving the Aircraft Carrier (AC) with zoom resilience and arrival tracking.',
  usage: 'move  OR  move <up|down|left|right> [px]',
  aliases: ['moveac', 'acmove', 'relocate'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const adb = botManager.getAdbController();
    const webhook = botManager.getWebhookService();

    // Support directional panning if user passes "up", "down", "left", "right"
    const firstArg = ctx.args[0]?.toLowerCase();
    if (['up', 'down', 'left', 'right'].includes(firstArg)) {
      const res = await adb.getScreenResolution();
      const screenW = res.width || 1080;
      const screenH = res.height || 2400;
      const centerX = Math.floor(screenW / 2);
      const centerY = Math.floor(screenH / 2);

      const customDist = parseInt(ctx.args[1], 10);
      const dist = isNaN(customDist) ? Math.floor(Math.min(screenW, screenH) * 0.35) : customDist;
      const duration = 400;

      let x1 = centerX;
      let y1 = centerY;
      let x2 = centerX;
      let y2 = centerY;

      if (firstArg === 'up') {
        y1 = centerY - Math.floor(dist / 2);
        y2 = centerY + Math.floor(dist / 2);
      } else if (firstArg === 'down') {
        y1 = centerY + Math.floor(dist / 2);
        y2 = centerY - Math.floor(dist / 2);
      } else if (firstArg === 'left') {
        x1 = centerX - Math.floor(dist / 2);
        x2 = centerX + Math.floor(dist / 2);
      } else if (firstArg === 'right') {
        x1 = centerX + Math.floor(dist / 2);
        x2 = centerX - Math.floor(dist / 2);
      }

      ctx.log(`🧭 Moving map ${firstArg} (${x1}, ${y1}) ➔ (${x2}, ${y2})...`, 'info');
      await adb.swipe(x1, y1, x2, y2, duration);
      const replyMsg = `🧭 Moved map **${firstArg}** (${dist}px)`;
      if (ctx.reply) await ctx.reply(replyMsg);
      return { success: true, message: replyMsg };
    }

    let currentStep = 1;
    ctx.log('🚀 Starting Aircraft Carrier (AC) Move sequence (with multi-scale zoom resilience)...', 'info');

    try {
      // =========================================================================
      // STEP 1: Check area 20-94 455-529 for fleet.png (with multi-scale zoom search)
      // If NO -> click 939-1062 2175-2302. If YES -> ignore click.
      // =========================================================================
      currentStep = 1;
      ctx.log('🔍 Step 1: Checking area for fleet.png across zoom scales...', 'info');
      let rawScreen = await adb.screencapRaw();
      const fleetPath = resolveAutoclickImagePath('fleet.png');

      let fleetMatched = false;
      if (fleetPath) {
        const match = await matchWithZoomResilience(
          rawScreen,
          fleetPath,
          { minX: 20, maxX: 94, minY: 455, maxY: 529 },
          0.65
        );
        fleetMatched = match.found;
        ctx.log(`fleet.png match: ${match.found} (score: ${(match.score * 100).toFixed(1)}%, scale: ${match.scale}x)`, 'info');
      } else {
        ctx.log('⚠️ fleet.png not found on SD card, assuming not matched.', 'warn');
      }

      if (!fleetMatched) {
        ctx.log('fleet.png NOT matched -> clicking 939-1062 2175-2302...', 'info');
        const tap1 = await adb.tapRandomRange(939, 1062, 2175, 2302);
        ctx.log(`Tapped (${tap1.x}, ${tap1.y}) in 939-1062 2175-2302`, 'info');
        await sleep(600);
      } else {
        ctx.log('fleet.png matched -> ignoring click as requested.', 'info');
        await sleep(300);
      }

      // =========================================================================
      // STEP 2: Click 644-688 2075-2119
      // =========================================================================
      currentStep = 2;
      ctx.log('👉 Step 2: Clicking 644-688 2075-2119...', 'info');
      const tap2 = await adb.tapRandomRange(644, 688, 2075, 2119);
      ctx.log(`Tapped (${tap2.x}, ${tap2.y}) in 644-688 2075-2119`, 'info');
      await sleep(500);

      // =========================================================================
      // STEP 3: Click 278-685 951-1047
      // =========================================================================
      currentStep = 3;
      ctx.log('👉 Step 3: Clicking 278-685 951-1047...', 'info');
      const tap3 = await adb.tapRandomRange(278, 685, 951, 1047);
      ctx.log(`Tapped (${tap3.x}, ${tap3.y}) in 278-685 951-1047`, 'info');
      await sleep(500);

      // =========================================================================
      // STEP 4: Click 595-880 1723-1807
      // =========================================================================
      currentStep = 4;
      ctx.log('👉 Step 4: Clicking 595-880 1723-1807...', 'info');
      const tap4 = await adb.tapRandomRange(595, 880, 1723, 1807);
      ctx.log(`Tapped (${tap4.x}, ${tap4.y}) in 595-880 1723-1807`, 'info');
      await sleep(500);

      // =========================================================================
      // STEP 5: Click fixed location (230, 1520) before acd1 step
      // =========================================================================
      currentStep = 5;
      ctx.log('👉 Step 5: Clicking fixed location (230, 1520)...', 'info');
      const tap5 = await adb.tap(230, 1520);
      ctx.log(`Tapped (${tap5.x}, ${tap5.y}) at fixed position (230, 1520)`, 'info');
      await sleep(600);

      // =========================================================================
      // STEP 6: Search for acd1.png button across all zoom levels and click it directly
      // =========================================================================
      currentStep = 6;
      ctx.log('🔍 Step 6: Searching for acd1.png button across all zoom scales...', 'info');
      rawScreen = await adb.screencapRaw();
      const acd1Path = resolveAutoclickImagePath('acd1.png');

      let acd1Matched = false;
      let tapX6 = 0;
      let tapY6 = 0;

      if (acd1Path) {
        const match1 = await matchWithZoomResilience(
          rawScreen,
          acd1Path,
          { minX: 460, maxX: 669, minY: 1601, maxY: 1645 },
          0.65
        );

        if (match1.found) {
          acd1Matched = true;
          tapX6 = match1.targetPoint.x;
          tapY6 = match1.targetPoint.y;
          ctx.log(`acd1.png button found at (${tapX6}, ${tapY6}) with score ${(match1.score * 100).toFixed(1)}% (scale ${match1.scale}x)!`, 'info');
        } else {
          ctx.log(`acd1.png match score ${(match1.score * 100).toFixed(1)}% (< 65%), skipping acd1 tap.`, 'info');
        }
      } else {
        ctx.log('⚠️ acd1.png not found on SD card, skipping conditional tap.', 'warn');
      }

      if (acd1Matched && tapX6 > 0 && tapY6 > 0) {
        ctx.log(`👉 Clicking acd1 button itself at (${tapX6}, ${tapY6})...`, 'info');
        const tapAcd1 = await adb.tap(tapX6, tapY6);
        ctx.log(`Tapped (${tapAcd1.x}, ${tapAcd1.y}) on acd1 button`, 'info');
        await sleep(500);
      } else {
        ctx.log('acd1 button not matched -> checking for prompt text "Yes" in 579-970 1707-1799...', 'info');
        const yesCheck = await checkTextInRegion(
          adb,
          { minX: 579, maxX: 970, minY: 1707, maxY: 1799 },
          'Yes'
        );

        if (yesCheck.found) {
          ctx.log(`Found prompt "Yes" (OCR: "${yesCheck.text}") -> clicking 158-507 1704-1796...`, 'info');
          const tapPromptOther = await adb.tapRandomRange(158, 507, 1704, 1796);
          ctx.log(`Tapped (${tapPromptOther.x}, ${tapPromptOther.y}) in 158-507 1704-1796`, 'info');
          await sleep(500);

          ctx.log('Clicking follow-up in 932-1056 2175-2305...', 'info');
          const tapFollowUp = await adb.tapRandomRange(932, 1056, 2175, 2305);
          ctx.log(`Tapped (${tapFollowUp.x}, ${tapFollowUp.y}) in 932-1056 2175-2305`, 'info');
          await sleep(600);

          // Swipe down all the way to reveal the building
          ctx.log('👇 Swiping down all the way to make building visible...', 'info');
          const screenRes = await adb.getScreenResolution();
          const sW = screenRes.width || 1080;
          const sH = screenRes.height || 2400;
          const swipeX = Math.floor(sW / 2);
          const fromY = Math.floor(sH * 0.20);
          const toY = Math.floor(sH * 0.85);
          await adb.swipe(swipeX, fromY, swipeX, toY, 600);
          await sleep(700);

          // Click building at 299-403 731-866
          ctx.log('👉 Clicking building in 299-403 731-866...', 'info');
          const tapBuilding = await adb.tapRandomRange(299, 403, 731, 866);
          ctx.log(`Tapped (${tapBuilding.x}, ${tapBuilding.y}) in 299-403 731-866`, 'info');
          await sleep(600);

          // Check if shiprepair.png exists in 569-737 836-973 (if yes click, if not ignore)
          ctx.log('🔍 Checking for shiprepair.png in 569-737 836-973...', 'info');
          const shipRepairPath = resolveAutoclickImagePath('shiprepair.png');
          if (shipRepairPath) {
            rawScreen = await adb.screencapRaw();
            const shipMatch = await matchWithZoomResilience(
              rawScreen,
              shipRepairPath,
              { minX: 569, maxX: 737, minY: 836, maxY: 973 },
              0.65
            );
            if (shipMatch.found) {
              ctx.log(`shiprepair.png found at (${shipMatch.targetPoint.x}, ${shipMatch.targetPoint.y}) -> clicking it!`, 'info');
              await adb.tap(shipMatch.targetPoint.x, shipMatch.targetPoint.y);
              await sleep(500);
            } else {
              ctx.log('shiprepair.png not found, ignoring as requested.', 'info');
            }
          }

          // Swipe to the left and search for text "Elizabeth" until found, then click it
          ctx.log('🔍 Searching for text "Elizabeth" (swiping left as needed)...', 'info');
          let elizabethPoint: { x: number; y: number } | undefined;
          const maxElizabethSwipes = 8;

          for (let s = 0; s <= maxElizabethSwipes; s++) {
            const elizCheck = await findAndClickText(adb, /elizabeth/i);
            if (elizCheck.found && elizCheck.point) {
              elizabethPoint = elizCheck.point;
              ctx.log(`👑 Found "Elizabeth" at (${elizabethPoint.x}, ${elizabethPoint.y}) (text: "${elizCheck.text}") -> clicking it!`, 'info');
              await adb.tap(elizabethPoint.x, elizabethPoint.y);
              await sleep(600);
              break;
            }

            if (s < maxElizabethSwipes) {
              ctx.log(`👉 Swiping left (attempt ${s + 1}/${maxElizabethSwipes}) to find "Elizabeth"...`, 'info');
              const swipeY = Math.floor(sH * 0.50);
              await adb.swipe(Math.floor(sW * 0.80), swipeY, Math.floor(sW * 0.20), swipeY, 400);
              await sleep(700);
            } else {
              ctx.log('⚠️ "Elizabeth" not found after max swipes, continuing...', 'warn');
            }
          }

          // After clicking elizabeth, search for img acre.png above the text, then click acre.png
          ctx.log('🔍 Searching for acre.png above Elizabeth text...', 'info');
          rawScreen = await adb.screencapRaw();
          const acrePath = resolveAutoclickImagePath('acre.png');
          if (acrePath) {
            const acreRegion = elizabethPoint
              ? { minX: 0, maxX: sW, minY: Math.max(0, elizabethPoint.y - 700), maxY: Math.max(100, elizabethPoint.y + 50) }
              : undefined;

            const acreMatch = await matchWithZoomResilience(rawScreen, acrePath, acreRegion, 0.62);
            if (acreMatch.found) {
              ctx.log(`acre.png found at (${acreMatch.targetPoint.x}, ${acreMatch.targetPoint.y}) with score ${(acreMatch.score * 100).toFixed(1)}% -> clicking it!`, 'info');
              await adb.tap(acreMatch.targetPoint.x, acreMatch.targetPoint.y);
              await sleep(600);
            } else {
              ctx.log('⚠️ acre.png not found on screen, continuing...', 'warn');
            }
          } else {
            ctx.log('⚠️ acre.png image file not found on SD card, skipping.', 'warn');
          }

          // Search for text "Repair" in area 376-717 1865-1971 and click it
          ctx.log('🔍 Searching for "Repair" in 376-717 1865-1971...', 'info');
          const repairCheck = await findAndClickText(adb, /repair/i, { minX: 376, maxX: 717, minY: 1865, maxY: 1971 });
          if (repairCheck.found && repairCheck.point) {
            ctx.log(`Found "Repair" text at (${repairCheck.point.x}, ${repairCheck.point.y}) -> clicking it!`, 'info');
            await adb.tap(repairCheck.point.x, repairCheck.point.y);
          } else {
            ctx.log('Tapping default range for "Repair" in 376-717 1865-1971...', 'info');
            await adb.tapRandomRange(376, 717, 1865, 1971);
          }
          await sleep(600);

          // After repair click X: 939–1062, Y: 2175–2302
          ctx.log('👉 After repair: Clicking 939-1062 2175-2302...', 'info');
          const tapPostRepair = await adb.tapRandomRange(939, 1062, 2175, 2302);
          ctx.log(`Tapped (${tapPostRepair.x}, ${tapPostRepair.y}) in 939-1062 2175-2302`, 'info');
          await sleep(600);
        } else {
          ctx.log('Prompt "Yes" not found, continuing regular clicks...', 'info');
          await sleep(300);
        }
      }

      // =========================================================================
      // STEP 7: Verify with acd2.png across all zoom levels then click it
      // =========================================================================
      currentStep = 7;
      ctx.log('🔍 Step 7: Verifying acd2.png across zoom scales...', 'info');
      rawScreen = await adb.screencapRaw();
      const acd2Path = resolveAutoclickImagePath('acd2.png');

      let tapX7 = Math.floor((576 + 849) / 2);
      let tapY7 = Math.floor((1407 + 1499) / 2);

      if (acd2Path) {
        const match2 = await matchWithZoomResilience(
          rawScreen,
          acd2Path,
          { minX: 576, maxX: 849, minY: 1407, maxY: 1499 },
          0.65
        );
        if (match2.found) {
          tapX7 = match2.targetPoint.x;
          tapY7 = match2.targetPoint.y;
          ctx.log(`acd2.png verified! Matched at (${tapX7}, ${tapY7}) with score ${(match2.score * 100).toFixed(1)}% (scale ${match2.scale}x)`, 'info');
        } else {
          ctx.log(`acd2.png match score ${(match2.score * 100).toFixed(1)}% (< 65%)`, 'warn');
        }
      }

      const tap7 = await adb.tapRandomRange(
        Math.max(576, tapX7 - 15),
        Math.min(849, tapX7 + 15),
        Math.max(1407, tapY7 - 10),
        Math.min(1499, tapY7 + 10)
      );
      ctx.log(`Tapped (${tap7.x}, ${tap7.y}) for acd2.png`, 'info');
      await sleep(500);

      // =========================================================================
      // STEP 8: Verify with acd3.png across all zoom levels then click it
      // =========================================================================
      currentStep = 8;
      ctx.log('🔍 Step 8: Verifying acd3.png across zoom scales...', 'info');
      rawScreen = await adb.screencapRaw();
      const acd3Path = resolveAutoclickImagePath('acd3.png');

      let tapX8 = Math.floor((597 + 970) / 2);
      let tapY8 = Math.floor((2181 + 2299) / 2);

      if (acd3Path) {
        const match3 = await matchWithZoomResilience(
          rawScreen,
          acd3Path,
          { minX: 597, maxX: 970, minY: 2181, maxY: 2299 },
          0.65
        );
        if (match3.found) {
          tapX8 = match3.targetPoint.x;
          tapY8 = match3.targetPoint.y;
          ctx.log(`acd3.png verified! Matched at (${tapX8}, ${tapY8}) with score ${(match3.score * 100).toFixed(1)}% (scale ${match3.scale}x)`, 'info');
        } else {
          ctx.log(`acd3.png match score ${(match3.score * 100).toFixed(1)}% (< 65%)`, 'warn');
        }
      }

      const tap8 = await adb.tapRandomRange(
        Math.max(597, tapX8 - 15),
        Math.min(970, tapX8 + 15),
        Math.max(2181, tapY8 - 10),
        Math.min(2299, tapY8 + 10)
      );
      ctx.log(`Tapped (${tap8.x}, ${tap8.y}) for acd3.png`, 'info');

      // =========================================================================
      // STEP 9: Wait 2 seconds
      // =========================================================================
      currentStep = 9;
      ctx.log('⏳ Waiting 2 seconds for travel timer to appear...', 'info');
      await sleep(2000);

      // =========================================================================
      // STEP 10: Check area for travel timer across zoom scales
      // If timer is NOT detected at all even at start -> send screenshot with step it stuck at!
      // If timer exists -> send "ac is moving" and poll every 10s until it disappears -> "arrived"
      // =========================================================================
      currentStep = 10;
      ctx.log('⏱️ Step 10: Checking for travel timer across zoom levels...', 'info');
      let timerCheck = await checkTimerExistsInRegion(adb);
      if (!timerCheck.exists) {
        await sleep(1500);
        timerCheck = await checkTimerExistsInRegion(adb);
      }
      if (!timerCheck.exists) {
        await sleep(1500);
        timerCheck = await checkTimerExistsInRegion(adb);
      }

      // If timer isn't detected at all even at start:
      if (!timerCheck.exists) {
        const failureReason = `timer not detected in 8-143 1832-1966 (OCR: "${timerCheck.text || 'none'}")`;
        await sendFailureScreenshot(adb, webhook, ctx, 10, failureReason);
        return {
          success: false,
          message: `Stuck at step 10: ${failureReason}`,
          data: { step: 10, rawOcr: timerCheck.text }
        };
      }

      const statusMsg = 'ac is moving';
      ctx.log(`📢 Status: "${statusMsg}" (OCR: "${timerCheck.text}")`, 'info');

      // Send the single message and capture its message ID to edit later
      let statusMsgId: string | undefined;
      if (webhook.isConfigured()) {
        const res = await webhook.send({ content: statusMsg }).catch(() => null);
        if (res?.success && res.messageId) {
          statusMsgId = res.messageId;
        }
      } else if (ctx.reply) {
        await ctx.reply(statusMsg);
      }

      // Cancel any previous background poll and start this new one
      const pollId = ++activeAcPollId;

      // Background loop: check every 10 seconds if the timer is still there
      (async () => {
        const maxCycles = 180; // 30 minutes max safety limit

        for (let cycle = 0; cycle < maxCycles; cycle++) {
          await sleep(10000); // Wait 10 seconds

          // Stop if a newer move command was initiated
          if (activeAcPollId !== pollId) {
            ctx.log('⏹️ Superseded by newer AC move command, stopping previous background poll.', 'info');
            return;
          }

          const check = await checkTimerExistsInRegion(adb);
          ctx.log(`[AC Check #${cycle + 1}] Timer still present: ${check.exists} ("${check.text}")`, 'info');

          if (!check.exists) {
            // Double check after 2 seconds to rule out screen transition or blink
            await sleep(2000);
            const recheck = await checkTimerExistsInRegion(adb);
            if (!recheck.exists) {
              ctx.log('🏁 Timer is no longer there! AC has arrived.', 'info');
              try {
                if (webhook.isConfigured() && statusMsgId) {
                  // Edit the "ac is moving" message in-place to "arrived"
                  const editRes = await webhook.edit(statusMsgId, { content: 'arrived' }).catch(() => null);
                  if (!editRes?.success) {
                    await webhook.send({ content: 'arrived' }).catch(() => {});
                  }
                } else if (webhook.isConfigured()) {
                  await webhook.send({ content: 'arrived' }).catch(() => {});
                } else if (ctx.reply) {
                  await ctx.reply('arrived');
                }
              } catch (err: any) {
                ctx.log(`Error updating arrival message: ${err.message}`, 'error');
              }
              return;
            }
          }
        }
      })().catch((err) => {
        ctx.log(`Background AC arrival poll error: ${err.message}`, 'error');
      });

      return {
        success: true,
        message: statusMsg,
        data: {
          timerFound: timerCheck.exists,
          rawText: timerCheck.text,
          messageId: statusMsgId
        }
      };
    } catch (err: any) {
      await sendFailureScreenshot(adb, webhook, ctx, currentStep, err.message);
      return {
        success: false,
        message: `Stuck at step ${currentStep}: ${err.message}`,
        data: { step: currentStep }
      };
    }
  }
};
