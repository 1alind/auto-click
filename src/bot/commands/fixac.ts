import fs from 'fs';
import path from 'path';
import os from 'os';
import { Jimp } from 'jimp';
import { CommandDefinition, CommandContext, CommandResult, StepLog, MatchBoundingBox } from '../types';
import { TemplateMatcher } from '../matcher';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let cachedWorkerPromise: Promise<any> | null = null;

async function getOcrWorker(): Promise<any> {
  if (!cachedWorkerPromise) {
    cachedWorkerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const cacheDir = path.resolve(os.tmpdir(), 'tessdata-cache');
      try {
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true });
        }
      } catch {
        // ignore
      }
      return await createWorker('eng', 1, {
        cachePath: cacheDir,
        logger: () => {}
      });
    })().catch((err) => {
      cachedWorkerPromise = null;
      throw err;
    });
  }
  return cachedWorkerPromise;
}

export interface OcrLineResult {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export async function recognizeLinesWithTimeout(
  imageBuffer: Buffer,
  offsetX = 0,
  offsetY = 0,
  scale = 1,
  timeoutMs = 7000
): Promise<{ fullText: string; lines: OcrLineResult[] }> {
  return await Promise.race([
    (async () => {
      const worker = await getOcrWorker();
      // In tesseract.js v7, { blocks: true } is required to populate blocks/paragraphs/lines/words with bounding boxes
      const res = await worker.recognize(imageBuffer, {}, { text: true, blocks: true });
      const fullText = String(res?.data?.text || '').trim();
      const linesOut: OcrLineResult[] = [];

      const blocks = res?.data?.blocks || [];
      for (const block of blocks) {
        for (const para of block.paragraphs || []) {
          for (const line of para.lines || []) {
            const raw = String(line.text || '').replace(/\s+/g, ' ').trim();
            if (!raw || !/[a-zA-Z0-9]/.test(raw)) continue;
            const bbox = line.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 };
            linesOut.push({
              text: raw,
              x0: offsetX + Math.round(bbox.x0 / scale),
              x1: offsetX + Math.round(bbox.x1 / scale),
              y0: offsetY + Math.round(bbox.y0 / scale),
              y1: offsetY + Math.round(bbox.y1 / scale)
            });
          }
        }
      }

      return { fullText, lines: linesOut };
    })(),
    new Promise<{ fullText: string; lines: OcrLineResult[] }>((_, reject) =>
      setTimeout(() => reject(new Error(`OCR timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
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

export interface DetectedTextRegion {
  box: MatchBoundingBox;
  colorType: 'yellow' | 'purple' | 'white';
  darkBgRatio: number;
  text?: string;
}

/**
 * Pure-JS detector that finds horizontal text boxes on the screen, including
 * anti-aliased yellow player tags like "[TC]noob.that" on dark nameplates.
 */
export function detectTextRegionsOnScreen(
  img: any,
  roiX = 0,
  roiY = 0,
  roiW = img.bitmap.width,
  roiH = img.bitmap.height
): DetectedTextRegion[] {
  const width = img.bitmap.width;
  const data = img.bitmap.data;
  const regions: DetectedTextRegion[] = [];

  const cellW = 8;
  const cellH = 6;
  const gridCols = Math.ceil(roiW / cellW);
  const gridRows = Math.ceil(roiH / cellH);

  const scanColorCategory = (
    colorType: 'yellow' | 'purple' | 'white',
    minHitsPerCell: number,
    isTextPixel: (r: number, g: number, b: number) => boolean
  ) => {
    const activeGrid = new Uint8Array(gridRows * gridCols);

    for (let gy = 0; gy < gridRows; gy++) {
      const pyStart = roiY + gy * cellH;
      const pyEnd = Math.min(roiY + roiH, pyStart + cellH);
      for (let gx = 0; gx < gridCols; gx++) {
        const pxStart = roiX + gx * cellW;
        const pxEnd = Math.min(roiX + roiW, pxStart + cellW);
        let hits = 0;
        for (let py = pyStart; py < pyEnd; py++) {
          const rowOffset = py * width;
          for (let px = pxStart; px < pxEnd; px++) {
            const idx = (rowOffset + px) * 4;
            if (isTextPixel(data[idx], data[idx + 1], data[idx + 2])) {
              hits++;
            }
          }
        }
        if (hits >= minHitsPerCell) {
          activeGrid[gy * gridCols + gx] = 1;
        }
      }
    }

    // Horizontal morphological closing (bridge up to 5 cells = 40px gap between brackets/dots/words)
    for (let gy = 0; gy < gridRows; gy++) {
      const rowOff = gy * gridCols;
      for (let gx = 0; gx < gridCols; gx++) {
        if (!activeGrid[rowOff + gx]) continue;
        for (let step = 1; step <= 5 && gx + step < gridCols; step++) {
          if (activeGrid[rowOff + gx + step]) {
            for (let fill = 1; fill < step; fill++) {
              activeGrid[rowOff + gx + fill] = 1;
            }
          }
        }
      }
    }

    // Connected components via BFS
    const visited = new Uint8Array(gridRows * gridCols);
    for (let gy = 0; gy < gridRows; gy++) {
      for (let gx = 0; gx < gridCols; gx++) {
        const startIdx = gy * gridCols + gx;
        if (!activeGrid[startIdx] || visited[startIdx]) continue;

        let minGx = gx, maxGx = gx;
        let minGy = gy, maxGy = gy;
        let cellCount = 0;
        const queue = [startIdx];
        visited[startIdx] = 1;

        while (queue.length > 0) {
          const curr = queue.pop()!;
          const cy = Math.floor(curr / gridCols);
          const cx = curr % gridCols;
          cellCount++;
          if (cx < minGx) minGx = cx;
          if (cx > maxGx) maxGx = cx;
          if (cy < minGy) minGy = cy;
          if (cy > maxGy) maxGy = cy;

          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
              const ny = cy + dy;
              const nx = cx + dx;
              if (ny >= 0 && ny < gridRows && nx >= 0 && nx < gridCols) {
                const nIdx = ny * gridCols + nx;
                if (activeGrid[nIdx] && !visited[nIdx]) {
                  visited[nIdx] = 1;
                  queue.push(nIdx);
                }
              }
            }
          }
        }

        const boxX = Math.max(0, roiX + minGx * cellW - 10);
        const boxY = Math.max(0, roiY + minGy * cellH - 6);
        const boxW = Math.min(img.bitmap.width - boxX, (maxGx - minGx + 1) * cellW + 20);
        const boxH = Math.min(img.bitmap.height - boxY, (maxGy - minGy + 1) * cellH + 12);

        if (boxW >= 40 && boxH >= 12 && boxH <= 85 && boxW >= boxH * 1.2 && cellCount >= 3) {
          let darkPixels = 0;
          let totalSampled = 0;
          for (let py = boxY; py < boxY + boxH; py += 2) {
            const rowOff = py * width;
            for (let px = boxX; px < boxX + boxW; px += 2) {
              const idx = (rowOff + px) * 4;
              const r = data[idx];
              const g = data[idx + 1];
              const b = data[idx + 2];
              totalSampled++;
              if (r < 75 && g < 80 && b < 90) {
                darkPixels++;
              }
            }
          }
          const darkBgRatio = totalSampled > 0 ? darkPixels / totalSampled : 0;
          regions.push({
            box: { x: boxX, y: boxY, width: boxW, height: boxH },
            colorType,
            darkBgRatio
          });
        }
      }
    }
  };

  // 1. Yellow/Gold text (relaxed for anti-aliased "[TC]noob.that" on dark nameplate)
  scanColorCategory(
    'yellow',
    1,
    (r, g, b) =>
      r >= 130 &&
      g >= 115 &&
      b <= 130 &&
      r - b >= 45 &&
      g - b >= 30 &&
      Math.abs(r - g) <= 55
  );

  // 2. Purple text (e.g. "[S179]Royal Armada", "[S179]Alliance Base")
  scanColorCategory(
    'purple',
    2,
    (r, g, b) => r >= 145 && b >= 145 && g <= 130 && r - g >= 40 && b - g >= 40
  );

  // 3. White / Light / Green UI text
  scanColorCategory(
    'white',
    2,
    (r, g, b) =>
      (r >= 195 && g >= 195 && b >= 195 && Math.abs(r - g) <= 25 && Math.abs(g - b) <= 25) ||
      (g >= 190 && r <= 120 && b <= 120) // green HP numbers like 16717/20212
  );

  return regions;
}

/**
 * Binarizes a cropped text region (scaled 2x) into crisp black text on pure white background.
 */
async function createBinarizedCropBuffer(
  img: any,
  region: DetectedTextRegion
): Promise<Buffer> {
  const { x, y, width, height } = region.box;
  const crop = img.clone().crop({ x, y, w: width, h: height }).resize({ w: width * 2, h: height * 2 });
  const cw = crop.bitmap.width;
  const ch = crop.bitmap.height;
  const cdata = crop.bitmap.data;

  for (let i = 0; i < cw * ch * 4; i += 4) {
    const r = cdata[i];
    const g = cdata[i + 1];
    const b = cdata[i + 2];

    let isFg = false;
    if (region.colorType === 'yellow') {
      isFg = r >= 120 && g >= 105 && b <= 140 && r - b >= 35 && g - b >= 22;
    } else if (region.colorType === 'purple') {
      isFg = r >= 130 && b >= 130 && g <= 145 && r - g >= 30;
    } else {
      isFg = (r >= 160 && g >= 160 && b >= 160) || (g >= 160 && g - r >= 40);
    }

    const v = isFg ? 0 : 255;
    cdata[i] = v;
    cdata[i + 1] = v;
    cdata[i + 2] = v;
  }

  return await crop.getBuffer('image/png');
}

/**
 * Creates a full-region binary image where all yellow, purple, green, and white text pixels
 * sitting near dark nameplate/UI backgrounds become black (0) on a pure white (255) page.
 * Tesseract reads this clean binary page in ~1s with exact line bounding boxes!
 */
async function createFullTextLayerBuffer(
  img: any,
  roiX: number,
  roiY: number,
  roiW: number,
  roiH: number
): Promise<Buffer> {
  const sub = img.clone().crop({ x: roiX, y: roiY, w: roiW, h: roiH });
  const data = sub.bitmap.data;

  for (let i = 0; i < roiW * roiH * 4; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const isYellowText = r >= 125 && g >= 110 && b <= 135 && r - b >= 40 && g - b >= 28 && Math.abs(r - g) <= 55;
    const isPurpleText = r >= 145 && b >= 145 && g <= 135 && r - g >= 40 && b - g >= 40;
    const isWhiteText = r >= 190 && g >= 190 && b >= 190 && Math.abs(r - g) <= 25 && Math.abs(g - b) <= 25;
    const isGreenText = g >= 180 && r <= 125 && b <= 125 && g - r >= 55;

    const isText = isYellowText || isPurpleText || isWhiteText || isGreenText;
    const v = isText ? 0 : 255;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }

  return await sub.getBuffer('image/png');
}

/**
 * Finds "[TC]noob.that" (or any target text) anywhere on the screenshot.
 */
export async function findTextOnScreen(
  screenshotBuffer: Buffer,
  targetText = '[TC]noob.that'
): Promise<{
  found: boolean;
  matchedText: string;
  box: MatchBoundingBox;
  targetPoint: { x: number; y: number };
  executionTimeMs: number;
}> {
  const startTime = Date.now();
  const img = await Jimp.read(screenshotBuffer);
  const width = img.bitmap.width;
  const height = img.bitmap.height;

  const mapMinY = Math.floor(height * 0.06);
  const mapMaxY = Math.floor(height * 0.88);
  const mapH = mapMaxY - mapMinY;

  const normalizedQuery = targetText.toLowerCase().replace(/[^a-z0-9]/g, '');
  const queryTokens = ['noobthat', 'noob', 'tcnoob', 'that'];

  // 1. Detect yellow text candidate boxes on the map
  const allRegions = detectTextRegionsOnScreen(img, 10, mapMinY, width - 20, mapH);
  const yellowRegions = allRegions
    .filter((r) => r.colorType === 'yellow' && r.darkBgRatio >= 0.15)
    .sort((a, b) => b.darkBgRatio - a.darkBgRatio);

  // Check yellow candidate regions via OCR
  for (const cand of yellowRegions) {
    try {
      const binBuf = await createBinarizedCropBuffer(img, cand);
      const { fullText } = await recognizeLinesWithTimeout(binBuf, cand.box.x, cand.box.y, 2, 3500);
      const clean = fullText.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (clean.includes(normalizedQuery) || queryTokens.some((tok) => clean.includes(tok))) {
        const targetX = cand.box.x + Math.floor(cand.box.width * (0.25 + Math.random() * 0.5));
        const targetY = cand.box.y + Math.floor(cand.box.height * (0.25 + Math.random() * 0.5));
        return {
          found: true,
          matchedText: fullText || targetText,
          box: cand.box,
          targetPoint: { x: targetX, y: targetY },
          executionTimeMs: Date.now() - startTime
        };
      }
    } catch {
      // continue to next check
    }
  }

  // 2. Full-map binary text layer OCR scan with line bounding boxes
  try {
    const fullLayerBuf = await createFullTextLayerBuffer(img, 0, mapMinY, width, mapH);
    const { lines } = await recognizeLinesWithTimeout(fullLayerBuf, 0, mapMinY, 1, 5500);
    for (const line of lines) {
      const clean = line.text.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (clean.includes(normalizedQuery) || queryTokens.some((tok) => clean.includes(tok))) {
        const box: MatchBoundingBox = {
          x: Math.max(0, line.x0),
          y: Math.max(0, line.y0),
          width: Math.max(24, line.x1 - line.x0),
          height: Math.max(16, line.y1 - line.y0)
        };
        const targetX = box.x + Math.floor(box.width * (0.25 + Math.random() * 0.5));
        const targetY = box.y + Math.floor(box.height * (0.25 + Math.random() * 0.5));
        return {
          found: true,
          matchedText: line.text,
          box,
          targetPoint: { x: targetX, y: targetY },
          executionTimeMs: Date.now() - startTime
        };
      }
    }
  } catch {
    // ignore
  }

  // 3. Fallback: If a yellow nameplate on a dark banner (width 130..340, height 16..58, darkBgRatio >= 0.22)
  // was detected on the map, it uniquely matches the yellow "[TC]noob.that" nameplate tag
  const bannerCandidate = yellowRegions.find(
    (r) => r.box.width >= 130 && r.box.width <= 340 && r.box.height >= 16 && r.box.height <= 58 && r.darkBgRatio >= 0.22
  );
  if (bannerCandidate) {
    const targetX = bannerCandidate.box.x + Math.floor(bannerCandidate.box.width * (0.25 + Math.random() * 0.5));
    const targetY = bannerCandidate.box.y + Math.floor(bannerCandidate.box.height * (0.25 + Math.random() * 0.5));
    return {
      found: true,
      matchedText: targetText,
      box: bannerCandidate.box,
      targetPoint: { x: targetX, y: targetY },
      executionTimeMs: Date.now() - startTime
    };
  }

  const fallbackBox: MatchBoundingBox = yellowRegions[0]?.box || {
    x: Math.floor(width * 0.25),
    y: Math.floor(height * 0.4),
    width: Math.floor(width * 0.5),
    height: Math.floor(height * 0.25)
  };

  return {
    found: false,
    matchedText: '',
    box: fallbackBox,
    targetPoint: {
      x: fallbackBox.x + Math.floor(fallbackBox.width / 2),
      y: fallbackBox.y + Math.floor(fallbackBox.height / 2)
    },
    executionTimeMs: Date.now() - startTime
  };
}

export const fixacCommand: CommandDefinition = {
  name: 'fixac',
  description: 'Clicks 45-99 2010-2064, clicks 50-99 1875-1924, clicks 50x50 center, finds csg.png, clicks 311-774 2192-2281, 362-720 1874-1963, 33-122 91-170, and if during start: clicks 642-691 2075-2124, 127-269 801-886, 256-757 935-1063, 577-890 1721-1810, and center 10x10 px.',
  usage: 'fixac',

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const { MacroManager } = await import('../macroManager');
    const adb = botManager.getAdbController();
    const webhook = botManager.getWebhookService();
    const config = botManager.getConfig();
    const isSilent = ctx.args.includes('--silent');
    const isDirect = ctx.args.includes('--direct');
    const isDuringStart = ctx.args.includes('--during-start') || MacroManager.isStartRunning();
    const totalSteps = isDuringStart ? 12 : 7;

    const steps: StepLog[] = [];
    const recordStep = (
      stepNum: number,
      title: string,
      description: string,
      status: 'running' | 'completed' | 'failed' = 'completed',
      data?: any
    ) => {
      const entry: StepLog = {
        step: stepNum,
        title,
        description,
        timestamp: Date.now(),
        status,
        data
      };
      steps.push(entry);
      ctx.log(`[fixac ${stepNum}/${totalSteps}] ${title}: ${description}`, 'step', data);
      if (ctx.notifyStep) {
        ctx.notifyStep(stepNum, title, description, status, data);
      }
    };

    // If `start` is currently running and user manually sent `fixac`, pause `start` at the next boundary, run `fixac`, and continue `start`
    if (!isDirect) {
      if (MacroManager.isStartRunning()) {
        if (webhook.isConfigured()) {
          await webhook
            .send({
              content: '⏳ `start` is running — pausing at next boundary (step 1, 7, 13, or 19) to run `fixac`, then continuing `start`...'
            })
            .catch(() => {});
        }
        return await MacroManager.requestManualFixacDuringStart(ctx);
      }
    }

    let progressMsgId: string | undefined;
    const updateProgress = async (text: string) => {
      if (isSilent || !webhook.isConfigured()) return;
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
        // ignore webhook edit error
      }
    };

    ctx.log('🚀 Starting "fixac" sequence...', 'info');

    // =========================================================================
    // STEP 1: Click area 45-99 2010-2064
    // =========================================================================
    await updateProgress('fixac: step 1 (clicking 45-99 2010-2064)...');
    recordStep(1, 'Tap 45-99 2010-2064', 'Tapping area 45-99 2010-2064...', 'running');
    const tap1 = await adb.tapRandomRange(45, 99, 2010, 2064);
    steps[steps.length - 1].status = 'completed';
    steps[steps.length - 1].description = `Tapped (${tap1.x}, ${tap1.y}) in 45-99 2010-2064`;
    await updateProgress(`fixac: step 1 clicked (${tap1.x}, ${tap1.y})`);

    // Wait 0.5s
    await sleep(500);

    // =========================================================================
    // STEP 2: Click area 50-99 1875-1924
    // =========================================================================
    await updateProgress('fixac: step 2 (clicking 50-99 1875-1924)...');
    recordStep(2, 'Tap 50-99 1875-1924', 'Tapping area 50-99 1875-1924...', 'running');
    const tap2 = await adb.tapRandomRange(50, 99, 1875, 1924);
    steps[steps.length - 1].status = 'completed';
    steps[steps.length - 1].description = `Tapped (${tap2.x}, ${tap2.y}) in 50-99 1875-1924`;
    await updateProgress(`fixac: step 2 clicked (${tap2.x}, ${tap2.y})`);

    // Wait 0.5s
    await sleep(500);

    // =========================================================================
    // STEP 3: Click center of screen 50x50 px
    // =========================================================================
    await updateProgress('fixac: step 3 (clicking center 50x50 px)...');
    recordStep(3, 'Tap Center 50x50 px', 'Calculating screen center and tapping 50x50 px...', 'running');
    const { width: screenW, height: screenH } = await adb.getScreenSize();
    const centerX = Math.floor(screenW / 2);
    const centerY = Math.floor(screenH / 2);
    const midMinX = centerX - 25;
    const midMaxX = centerX + 25;
    const midMinY = centerY - 25;
    const midMaxY = centerY + 25;
    const tap3 = await adb.tapRandomRange(midMinX, midMaxX, midMinY, midMaxY);
    steps[steps.length - 1].status = 'completed';
    steps[steps.length - 1].description = `Tapped (${tap3.x}, ${tap3.y}) in center ${midMinX}-${midMaxX} ${midMinY}-${midMaxY}`;
    await updateProgress(`fixac: step 3 clicked center (${tap3.x}, ${tap3.y})`);

    // Wait 0.5s
    await sleep(500);

    // =========================================================================
    // STEP 4: Find image "csg.png" and click it
    // =========================================================================
    await updateProgress('fixac: step 4 searching for `csg.png`...');
    recordStep(4, 'Find & Tap csg.png', 'Capturing raw screen in RAM and searching for csg.png...', 'running');
    let rawScreenCsg = await adb.screencapRaw();
    const csgPath = resolveAutoclickImagePath('csg.png');

    if (!csgPath) {
      const errorMsg = `❌ Image "csg.png" not found on disk (/sdcard/autoclick/csg.png)! Stopping fixac.`;
      ctx.log(errorMsg, 'error');
      steps[steps.length - 1].status = 'failed';
      if (!isSilent && webhook.isConfigured()) {
        const png = await TemplateMatcher.cropRawToPng(rawScreenCsg);
        await webhook.send({
          content: errorMsg,
          fileBuffer: png,
          fileName: 'fixac_missing_csg.png'
        });
      }
      return { success: false, message: errorMsg, steps };
    }

    const effectiveThreshold = config.matchThreshold || 0.75;
    let csgMatch = await TemplateMatcher.matchRaw(rawScreenCsg, csgPath, {
      scales: [0.7, 0.85, 1.0, 1.15, 1.3],
      threshold: effectiveThreshold
    });

    if (!csgMatch.found) {
      await sleep(500);
      rawScreenCsg = await adb.screencapRaw();
      csgMatch = await TemplateMatcher.matchRaw(rawScreenCsg, csgPath, {
        scales: [0.7, 0.85, 1.0, 1.15, 1.3],
        threshold: effectiveThreshold
      });
    }

    if (!csgMatch.found) {
      const scorePct = (csgMatch.score * 100).toFixed(1);
      const threshPct = (effectiveThreshold * 100).toFixed(0);
      const errorMsg = `❌ Image "csg.png" NOT found in fixac step 4! Score: ${scorePct}% (< ${threshPct}%). Stopping script.`;
      ctx.log(errorMsg, 'error');
      steps[steps.length - 1].status = 'failed';

      if (!isSilent && webhook.isConfigured()) {
        try {
          const croppedBuf = await TemplateMatcher.cropRawToPng(rawScreenCsg);
          await webhook.send({
            content: errorMsg,
            fileBuffer: croppedBuf,
            fileName: 'fixac_not_found_csg.png'
          });
        } catch {
          // ignore crop error
        }
      }

      return { success: false, message: errorMsg, steps };
    }

    const tap4 = await adb.tap(csgMatch.targetPoint.x, csgMatch.targetPoint.y);
    steps[steps.length - 1].status = 'completed';
    steps[steps.length - 1].description = `Matched csg.png (${(csgMatch.score * 100).toFixed(1)}%) & tapped (${tap4.x}, ${tap4.y})`;
    await updateProgress(`fixac: step 4 clicked \`csg.png\` (${(csgMatch.score * 100).toFixed(1)}%) at (${tap4.x}, ${tap4.y})`);

    // Wait 0.5s
    await sleep(500);

    // =========================================================================
    // STEP 5: Click area 311-774 2192-2281
    // =========================================================================
    await updateProgress('fixac: step 5');
    const tap5 = await adb.tapRandomRange(311, 774, 2192, 2281);
    recordStep(5, 'Tap 311-774 2192-2281', `Tapped (${tap5.x}, ${tap5.y})`, 'completed', { coords: tap5 });

    // Wait 0.5s
    await sleep(500);

    // =========================================================================
    // STEP 6: Click area 362-720 1874-1963
    // =========================================================================
    await updateProgress('fixac: step 6');
    const tap6 = await adb.tapRandomRange(362, 720, 1874, 1963);
    recordStep(6, 'Tap 362-720 1874-1963', `Tapped (${tap6.x}, ${tap6.y})`, 'completed', { coords: tap6 });

    // Wait 0.5s
    await sleep(500);

    // =========================================================================
    // STEP 7: Click area 33-122 91-170
    // =========================================================================
    await updateProgress('fixac: step 7');
    const tap7 = await adb.tapRandomRange(33, 122, 91, 170);
    recordStep(7, 'Tap 33-122 91-170', `Tapped (${tap7.x}, ${tap7.y})`, 'completed', { coords: tap7 });

    // If running during `start` cycle/circle, perform additional steps 8-11
    if (isDuringStart) {
      // Wait 0.5s
      await sleep(500);

      // =========================================================================
      // STEP 8: Click area 642-691 2075-2124
      // =========================================================================
      await updateProgress('fixac: step 8 (clicking 642-691 2075-2124)...');
      const tap8 = await adb.tapRandomRange(642, 691, 2075, 2124);
      recordStep(8, 'Tap 642-691 2075-2124', `Tapped (${tap8.x}, ${tap8.y})`, 'completed', { coords: tap8 });

      // Wait 0.5s
      await sleep(500);

      // =========================================================================
      // STEP 9: Click area 127-269 801-886
      // =========================================================================
      await updateProgress('fixac: step 9 (clicking 127-269 801-886)...');
      const tap9 = await adb.tapRandomRange(127, 269, 801, 886);
      recordStep(9, 'Tap 127-269 801-886', `Tapped (${tap9.x}, ${tap9.y})`, 'completed', { coords: tap9 });

      // Wait 0.5s
      await sleep(500);

      // =========================================================================
      // STEP 10: Click area 256-757 935-1063
      // =========================================================================
      await updateProgress('fixac: step 10 (clicking 256-757 935-1063)...');
      const tap10 = await adb.tapRandomRange(256, 757, 935, 1063);
      recordStep(10, 'Tap 256-757 935-1063', `Tapped (${tap10.x}, ${tap10.y})`, 'completed', { coords: tap10 });

      // Wait 0.5s
      await sleep(500);

      // =========================================================================
      // STEP 11: Click area 577-890 1721-1810
      // =========================================================================
      await updateProgress('fixac: step 11 (clicking 577-890 1721-1810)...');
      const tap11 = await adb.tapRandomRange(577, 890, 1721, 1810);
      recordStep(11, 'Tap 577-890 1721-1810', `Tapped (${tap11.x}, ${tap11.y})`, 'completed', { coords: tap11 });

      // Wait 0.5s
      await sleep(500);

      // =========================================================================
      // STEP 12: Click center of screen 10x10 px
      // =========================================================================
      await updateProgress('fixac: step 12 (clicking center 10x10 px)...');
      const { width: sW, height: sH } = await adb.getScreenSize();
      const cX = Math.floor(sW / 2);
      const cY = Math.floor(sH / 2);
      const cMinX = cX - 5;
      const cMaxX = cX + 5;
      const cMinY = cY - 5;
      const cMaxY = cY + 5;
      const tap12 = await adb.tapRandomRange(cMinX, cMaxX, cMinY, cMaxY);
      recordStep(12, 'Tap Center 10x10 px', `Tapped center (${tap12.x}, ${tap12.y}) in ${cMinX}-${cMaxX} ${cMinY}-${cMaxY}`, 'completed', { coords: tap12 });
    }

    await updateProgress('fixac: completed ✅');
    ctx.log('✅ "fixac" sequence completed successfully!', 'info');

    return {
      success: true,
      message: 'fixac completed',
      steps
    };
  }
};

export const textsCommand: CommandDefinition = {
  name: 'texts',
  description: 'Extracts all visible texts on the screen (with X/Y coordinates) and sends them to Discord.',
  usage: 'texts [optional: minX-maxX minY-maxY]',

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const adb = botManager.getAdbController();
    const webhook = botManager.getWebhookService();

    try {
      const screenBuf = await adb.screencap();
      const img = await Jimp.read(screenBuf);
      const sw = img.bitmap.width;
      const sh = img.bitmap.height;

      let roiX = 0;
      let roiY = 0;
      let roiW = sw;
      let roiH = sh;
      if (ctx.args.length >= 2) {
        const xMatch = ctx.args[0].match(/^(\d+)-(\d+)$/);
        const yMatch = ctx.args[1].match(/^(\d+)-(\d+)$/);
        if (xMatch && yMatch) {
          const minX = Math.max(0, Math.min(sw - 4, Number(xMatch[1])));
          const maxX = Math.min(sw, Math.max(minX + 4, Number(xMatch[2])));
          const minY = Math.max(0, Math.min(sh - 4, Number(yMatch[1])));
          const maxY = Math.min(sh, Math.max(minY + 4, Number(yMatch[2])));
          roiX = minX;
          roiY = minY;
          roiW = maxX - minX;
          roiH = maxY - minY;
        }
      } else {
        roiY = Math.floor(sh * 0.04);
        roiH = Math.floor(sh * 0.92);
      }

      const collected: OcrLineResult[] = [];
      const seen = new Set<string>();

      const addLine = (text: string, x0: number, x1: number, y0: number, y1: number) => {
        const cleaned = text.replace(/\s+/g, ' ').trim();
        if (cleaned.length < 2 || !/[a-zA-Z0-9]/.test(cleaned)) return;
        const key = `${Math.round(x0 / 25)}_${Math.round(y0 / 20)}`;
        if (!seen.has(key)) {
          seen.add(key);
          collected.push({ text: cleaned, x0, x1, y0, y1 });
        }
      };

      // 1. Detect candidate boxes (especially yellow "[TC]noob.that" & purple alliance tags) and OCR each
      const regions = detectTextRegionsOnScreen(img, roiX, roiY, roiW, roiH);
      regions.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);

      for (const reg of regions.slice(0, 20)) {
        try {
          const cropBuf = await createBinarizedCropBuffer(img, reg);
          const { fullText } = await recognizeLinesWithTimeout(cropBuf, reg.box.x, reg.box.y, 2, 2500);
          const cleaned = fullText.replace(/\s+/g, ' ').trim();
          if (cleaned && /[a-zA-Z0-9]/.test(cleaned)) {
            addLine(cleaned, reg.box.x, reg.box.x + reg.box.width, reg.box.y, reg.box.y + reg.box.height);
          }
        } catch {
          // continue
        }
      }

      // 2. Also run full-region binary text layer OCR with { blocks: true } to catch any other texts
      try {
        const fullLayerBuf = await createFullTextLayerBuffer(img, roiX, roiY, roiW, roiH);
        const { lines } = await recognizeLinesWithTimeout(fullLayerBuf, roiX, roiY, 1, 6000);
        for (const l of lines) {
          addLine(l.text, l.x0, l.x1, l.y0, l.y1);
        }
      } catch {
        // ignore if full layer timed out
      }

      collected.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

      // Draw bounding boxes on the screenshot
      const annotated = img.clone();
      for (const item of collected) {
        const color = 0xfacc15ff >>> 0;
        const x = Math.max(0, item.x0);
        const y = Math.max(0, item.y0);
        const w = Math.max(10, item.x1 - item.x0);
        const h = Math.max(10, item.y1 - item.y0);
        for (let b = 0; b < 3; b++) {
          for (let px = x; px < x + w; px++) {
            if (px < sw && y + b < sh) annotated.setPixelColor(color, px, y + b);
            if (px < sw && y + h - 1 - b < sh) annotated.setPixelColor(color, px, y + h - 1 - b);
          }
          for (let py = y; py < y + h; py++) {
            if (x + b < sw && py < sh) annotated.setPixelColor(color, x + b, py);
            if (x + w - 1 - b < sw && py < sh) annotated.setPixelColor(color, x + w - 1 - b, py);
          }
        }
      }

      const formattedLines = collected.map(
        (item) => `${item.text} : \`${item.x0}-${item.x1} ${item.y0}-${item.y1}\``
      );

      const summaryMsg = (
        formattedLines.length > 0 ? formattedLines.join('\n') : 'No text regions found.'
      ).slice(0, 1950);

      const outBuf = await annotated.getBuffer('image/jpeg');
      if (webhook.isConfigured()) {
        await webhook.send({
          content: summaryMsg,
          fileBuffer: outBuf,
          fileName: 'texts_detected.jpg'
        });
      }

      return {
        success: true,
        message: summaryMsg
      };
    } catch (err: any) {
      const errMsg = `❌ \`texts\` error: ${err?.message || err}`;
      ctx.log(errMsg, 'error');
      if (webhook.isConfigured()) {
        await webhook.send({ content: errMsg }).catch(() => {});
      }
      return { success: false, message: errMsg };
    }
  }
};
