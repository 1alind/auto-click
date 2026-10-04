import { Jimp } from 'jimp';
import { CommandDefinition, CommandContext, CommandResult } from '../types';
import { TemplateMatcher } from '../matcher';
import { resolveAutoclickImagePath, recognizeLinesWithTimeout } from './fixac';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let activeAcTimer: NodeJS.Timeout | null = null;

function parseTimerToSeconds(text: string): { totalSeconds: number; formatted: string } | null {
  const clean = text.replace(/\s+/g, ' ').trim();

  // Pattern 1: HH:MM:SS or MM:SS (e.g. 04:30, 4:30, 01:15:20)
  const colonMatch = clean.match(/(?:(\d{1,2})[:;])?(\d{1,2})[:;](\d{2})/);
  if (colonMatch) {
    const hours = colonMatch[1] ? parseInt(colonMatch[1], 10) : 0;
    const minutes = parseInt(colonMatch[2], 10);
    const seconds = parseInt(colonMatch[3], 10);
    const total = hours * 3600 + minutes * 60 + seconds;

    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
    if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds} second${seconds > 1 ? 's' : ''}`);

    return {
      totalSeconds: total,
      formatted: parts.join(' and ')
    };
  }

  // Pattern 2: e.g. "4m 30s" or "4m30s"
  const msMatch = clean.match(/(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  if (msMatch && (msMatch[1] || msMatch[2] || msMatch[3])) {
    const hours = msMatch[1] ? parseInt(msMatch[1], 10) : 0;
    const minutes = msMatch[2] ? parseInt(msMatch[2], 10) : 0;
    const seconds = msMatch[3] ? parseInt(msMatch[3], 10) : 0;
    const total = hours * 3600 + minutes * 60 + seconds;
    if (total > 0) {
      const parts: string[] = [];
      if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
      if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
      if (seconds > 0 || parts.length === 0) parts.push(`${seconds} second${seconds > 1 ? 's' : ''}`);

      return {
        totalSeconds: total,
        formatted: parts.join(' and ')
      };
    }
  }

  return null;
}

export const moveCommand: CommandDefinition = {
  name: 'move',
  description: 'Automates moving the Aircraft Carrier (AC) and tracks arrival timer.',
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

    ctx.log('🚀 Starting Aircraft Carrier (AC) Move sequence...', 'info');

    // =========================================================================
    // STEP 1: Check area 20-94 455-529 for fleet.png
    // If NO -> click 939-1062 2175-2302. If YES -> ignore click.
    // =========================================================================
    ctx.log('🔍 Step 1: Checking area 20-94 455-529 for fleet.png...', 'info');
    let rawScreen = await adb.screencapRaw();
    const fleetPath = resolveAutoclickImagePath('fleet.png');

    let fleetMatched = false;
    if (fleetPath) {
      const match = await TemplateMatcher.matchRaw(rawScreen, fleetPath, {
        region: { minX: 20, maxX: 94, minY: 455, maxY: 529 },
        threshold: 0.72,
        scales: [0.85, 1.0, 1.15]
      });
      fleetMatched = match.found;
      ctx.log(`fleet.png match: ${match.found} (score: ${(match.score * 100).toFixed(1)}%)`, 'info');
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
    ctx.log('👉 Step 2: Clicking 644-688 2075-2119...', 'info');
    const tap2 = await adb.tapRandomRange(644, 688, 2075, 2119);
    ctx.log(`Tapped (${tap2.x}, ${tap2.y}) in 644-688 2075-2119`, 'info');
    await sleep(500);

    // =========================================================================
    // STEP 3: Click 278-685 951-1047
    // =========================================================================
    ctx.log('👉 Step 3: Clicking 278-685 951-1047...', 'info');
    const tap3 = await adb.tapRandomRange(278, 685, 951, 1047);
    ctx.log(`Tapped (${tap3.x}, ${tap3.y}) in 278-685 951-1047`, 'info');
    await sleep(500);

    // =========================================================================
    // STEP 4: Click 595-880 1723-1807
    // =========================================================================
    ctx.log('👉 Step 4: Clicking 595-880 1723-1807...', 'info');
    const tap4 = await adb.tapRandomRange(595, 880, 1723, 1807);
    ctx.log(`Tapped (${tap4.x}, ${tap4.y}) in 595-880 1723-1807`, 'info');
    await sleep(500);

    // =========================================================================
    // STEP 5: Click 236-325 1455-1544
    // =========================================================================
    ctx.log('👉 Step 5: Clicking 236-325 1455-1544...', 'info');
    const tap5 = await adb.tapRandomRange(236, 325, 1455, 1544);
    ctx.log(`Tapped (${tap5.x}, ${tap5.y}) in 236-325 1455-1544`, 'info');
    await sleep(600);

    // =========================================================================
    // STEP 6: Check area 460-669 1601-1645 for acd1.png
    // If YES -> click 539-603 1476-1538
    // =========================================================================
    ctx.log('🔍 Step 6: Checking area 460-669 1601-1645 for acd1.png...', 'info');
    rawScreen = await adb.screencapRaw();
    const acd1Path = resolveAutoclickImagePath('acd1.png');

    let acd1Matched = false;
    if (acd1Path) {
      const match1 = await TemplateMatcher.matchRaw(rawScreen, acd1Path, {
        region: { minX: 460, maxX: 669, minY: 1601, maxY: 1645 },
        threshold: 0.72,
        scales: [0.85, 1.0, 1.15]
      });
      acd1Matched = match1.found;
      ctx.log(`acd1.png match: ${match1.found} (score: ${(match1.score * 100).toFixed(1)}%)`, 'info');
    } else {
      ctx.log('⚠️ acd1.png not found on SD card, skipping conditional tap.', 'warn');
    }

    if (acd1Matched) {
      ctx.log('acd1.png matched -> clicking 539-603 1476-1538...', 'info');
      const tapAcd1 = await adb.tapRandomRange(539, 603, 1476, 1538);
      ctx.log(`Tapped (${tapAcd1.x}, ${tapAcd1.y}) in 539-603 1476-1538`, 'info');
      await sleep(500);
    } else {
      ctx.log('acd1.png not matched, continuing...', 'info');
      await sleep(300);
    }

    // =========================================================================
    // STEP 7: Verify 576-849 1407-1499 with acd2.png then click it
    // =========================================================================
    ctx.log('🔍 Step 7: Verifying 576-849 1407-1499 with acd2.png...', 'info');
    rawScreen = await adb.screencapRaw();
    const acd2Path = resolveAutoclickImagePath('acd2.png');

    let tapX7 = Math.floor((576 + 849) / 2);
    let tapY7 = Math.floor((1407 + 1499) / 2);

    if (acd2Path) {
      const match2 = await TemplateMatcher.matchRaw(rawScreen, acd2Path, {
        region: { minX: 576, maxX: 849, minY: 1407, maxY: 1499 },
        threshold: 0.70,
        scales: [0.85, 1.0, 1.15]
      });
      if (match2.found) {
        tapX7 = match2.targetPoint.x;
        tapY7 = match2.targetPoint.y;
        ctx.log(`acd2.png verified! Matched at (${tapX7}, ${tapY7}) with score ${(match2.score * 100).toFixed(1)}%`, 'info');
      } else {
        ctx.log(`acd2.png match score ${(match2.score * 100).toFixed(1)}% (< 70%), using default button coords`, 'warn');
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
    // STEP 8: Verify 597-970 2181-2299 with acd3.png then click it
    // =========================================================================
    ctx.log('🔍 Step 8: Verifying 597-970 2181-2299 with acd3.png...', 'info');
    rawScreen = await adb.screencapRaw();
    const acd3Path = resolveAutoclickImagePath('acd3.png');

    let tapX8 = Math.floor((597 + 970) / 2);
    let tapY8 = Math.floor((2181 + 2299) / 2);

    if (acd3Path) {
      const match3 = await TemplateMatcher.matchRaw(rawScreen, acd3Path, {
        region: { minX: 597, maxX: 970, minY: 2181, maxY: 2299 },
        threshold: 0.70,
        scales: [0.85, 1.0, 1.15]
      });
      if (match3.found) {
        tapX8 = match3.targetPoint.x;
        tapY8 = match3.targetPoint.y;
        ctx.log(`acd3.png verified! Matched at (${tapX8}, ${tapY8}) with score ${(match3.score * 100).toFixed(1)}%`, 'info');
      } else {
        ctx.log(`acd3.png match score ${(match3.score * 100).toFixed(1)}% (< 70%), using default button coords`, 'warn');
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
    ctx.log('⏳ Waiting 2 seconds for travel timer to appear...', 'info');
    await sleep(2000);

    // =========================================================================
    // STEP 10: Scan texts in area 8-143 1832-1966 for timer
    // =========================================================================
    ctx.log('⏱️ Step 10: Scanning texts in 8-143 1832-1966 for travel timer...', 'info');
    const screenPng = await adb.screencap();
    const screenImg = await Jimp.read(screenPng);

    // Crop area 8-143 1832-1966
    const cropX = Math.max(0, 8);
    const cropY = Math.max(0, 1832);
    const cropW = Math.max(10, 143 - cropX);
    const cropH = Math.max(10, 1966 - cropY);

    const cropped = screenImg.clone().crop({ x: cropX, y: cropY, w: cropW, h: cropH });
    // Upscale for ultra-sharp OCR on numbers/colons
    cropped.resize({ w: cropW * 2, h: cropH * 2 });
    const cropBuf = await cropped.getBuffer('image/png');

    let scannedText = '';
    try {
      const ocrRes = await recognizeLinesWithTimeout(cropBuf, cropX, cropY, 2, 8000);
      scannedText = ocrRes.fullText || ocrRes.lines.map((l) => l.text).join(' ');
      ctx.log(`OCR raw text in timer area: "${scannedText}"`, 'info');
    } catch (err: any) {
      ctx.log(`OCR error on timer area: ${err.message}`, 'warn');
    }

    const timerData = parseTimerToSeconds(scannedText);
    const msg = timerData && timerData.totalSeconds > 0
      ? `ac will be areive in ${timerData.formatted}..`
      : (scannedText.trim()
          ? `ac will be areive in ${scannedText.trim()}..`
          : 'ac will be areive in 4 minutes and 30 seconds..');

    const durationSeconds = timerData && timerData.totalSeconds > 0 ? timerData.totalSeconds : 270;

    ctx.log(`📢 ${msg}`, 'info');

    // Send single message and capture its message ID to edit later
    let timerMessageId: string | undefined;
    if (webhook.isConfigured()) {
      const res = await webhook.send({ content: msg }).catch(() => null);
      if (res?.success && res.messageId) {
        timerMessageId = res.messageId;
      }
    } else if (ctx.reply) {
      await ctx.reply(msg);
    }

    // Clear any previous active arrival timer
    if (activeAcTimer) {
      clearTimeout(activeAcTimer);
      activeAcTimer = null;
    }

    ctx.log(`⏱️ Setting arrival timer for ${durationSeconds}s (will edit message ${timerMessageId || 'in-place'})...`, 'info');
    activeAcTimer = setTimeout(async () => {
      ctx.log('🚢 Carrier arrival timer finished! Updating message to "arrived."', 'info');
      try {
        if (webhook.isConfigured() && timerMessageId) {
          // Edit the exact previous message that had the timer in-place!
          const editRes = await webhook.edit(timerMessageId, { content: 'arrived.' });
          if (!editRes.success) {
            await webhook.send({ content: 'arrived.' }).catch(() => {});
          }
        } else if (webhook.isConfigured()) {
          await webhook.send({ content: 'arrived.' }).catch(() => {});
        } else if (ctx.reply) {
          await ctx.reply('arrived.');
        }
      } catch (err: any) {
        ctx.log(`Error updating arrival message: ${err.message}`, 'error');
      } finally {
        activeAcTimer = null;
      }
    }, durationSeconds * 1000);

    return {
      success: true,
      message: msg,
      data: {
        timerSeconds: durationSeconds,
        formatted: timerData?.formatted || scannedText,
        messageId: timerMessageId
      }
    };
  }
};
