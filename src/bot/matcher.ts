import { Jimp } from 'jimp';
import fs from 'fs';
import path from 'path';
import { MatchResult, MatchBoundingBox } from './types';

export class TemplateMatcher {
  private static templateCache: { path: string; mtimeMs: number; jimpImg: any } | null = null;
  private static multiTemplateCache = new Map<
    string,
    { mtimeMs: number; jimpImg: any; scaledMap: Map<string, { w: number; h: number; data: Buffer | Uint8Array }> }
  >();

  /**
   * Performs multi-scale template matching using pure JavaScript Jimp (zero native C++ dependencies).
   * 100% compatible with Android Termux (ARM64/bionic libc).
   */
  public static async match(
    screenshotBuffer: Buffer,
    templatePathOrBuffer: string | Buffer,
    options: {
      scales?: number[];
      threshold?: number;
      drawDebugBox?: boolean;
      region?: { minX: number; maxX: number; minY: number; maxY: number };
    } = {}
  ): Promise<MatchResult> {
    const startTime = Date.now();
    const scales = options.scales && options.scales.length > 0
      ? options.scales
      : [0.65, 0.8, 0.9, 1.0, 1.1, 1.25];
    const threshold = options.threshold ?? 0.75;

    // Load template image (with mtime cache so disk & JPEG decode only happens once)
    let templateJimp: any;
    if (typeof templatePathOrBuffer === 'string') {
      const resolvedPath = path.resolve(process.cwd(), templatePathOrBuffer);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Template image not found at path: ${resolvedPath}`);
      }
      const stat = fs.statSync(resolvedPath);
      if (
        this.templateCache &&
        this.templateCache.path === resolvedPath &&
        this.templateCache.mtimeMs === stat.mtimeMs
      ) {
        templateJimp = this.templateCache.jimpImg.clone();
      } else {
        const fileBuf = await fs.promises.readFile(resolvedPath);
        const loaded = await Jimp.read(fileBuf);
        this.templateCache = { path: resolvedPath, mtimeMs: stat.mtimeMs, jimpImg: loaded };
        templateJimp = loaded.clone();
      }
    } else {
      templateJimp = await Jimp.read(templatePathOrBuffer);
    }

    const screenJimp = await Jimp.read(screenshotBuffer);
    const screenWidth = screenJimp.bitmap.width;
    const screenHeight = screenJimp.bitmap.height;

    // For tight regions (e.g. 69x69 button boxes), add a small search margin so 1.0x templates fit without shrinking
    const margin = options.region && Math.min( options.region.maxX - options.region.minX, options.region.maxY - options.region.minY ) < 140 ? 18 : 0;
    const roiX = options.region ? Math.max(0, Math.min(options.region.minX - margin, screenWidth - 16)) : 0;
    const roiY = options.region ? Math.max(0, Math.min(options.region.minY - margin, screenHeight - 16)) : 0;
    const roiW = options.region
      ? Math.max(16, Math.min(options.region.maxX + margin - roiX, screenWidth - roiX))
      : screenWidth;
    const roiH = options.region
      ? Math.max(16, Math.min(options.region.maxY + margin - roiY, screenHeight - roiY))
      : screenHeight;

    // Crop in-place unless debug overlay needs the full screen
    const searchRegionJimp = options.region
      ? (options.drawDebugBox ? screenJimp.clone() : screenJimp).crop({ x: roiX, y: roiY, w: roiW, h: roiH })
      : screenJimp;

    // Normalize template base dimensions only if larger than the search region (or > 380px)
    const maxAllowedW = Math.min(380, Math.floor(roiW * 0.9));
    const maxAllowedH = Math.min(380, Math.floor(roiH * 0.9));
    if (templateJimp.bitmap.width > maxAllowedW || templateJimp.bitmap.height > maxAllowedH) {
      const normFactor = Math.min(maxAllowedW / templateJimp.bitmap.width, maxAllowedH / templateJimp.bitmap.height);
      templateJimp = templateJimp.resize({
        w: Math.max(12, Math.round(templateJimp.bitmap.width * normFactor)),
        h: Math.max(12, Math.round(templateJimp.bitmap.height * normFactor))
      });
    }

    const baseTemplateWidth = templateJimp.bitmap.width;
    const baseTemplateHeight = templateJimp.bitmap.height;

    const downscale =
      Math.min(baseTemplateWidth, baseTemplateHeight) <= 55 || Math.min(roiW, roiH) <= 140
        ? 2
        : options.region
        ? 3
        : Math.max(3, Math.round(roiW / 200));
    const coarseW = Math.max(16, Math.floor(roiW / downscale));
    const coarseH = Math.max(16, Math.floor(roiH / downscale));
    const coarseScreen = searchRegionJimp.resize({ w: coarseW, h: coarseH });
    const screenData = coarseScreen.bitmap.data;

    let bestScore = -1;
    let bestBox: MatchBoundingBox = {
      x: roiX + Math.max(0, Math.floor(roiW / 2 - baseTemplateWidth / 2)),
      y: roiY + Math.max(0, Math.floor(roiH / 2 - baseTemplateHeight / 2)),
      width: Math.min(roiW, baseTemplateWidth),
      height: Math.min(roiH, baseTemplateHeight)
    };
    let bestScale = 1.0;

    for (const scale of scales) {
      const scaledW = Math.max(6, Math.round((baseTemplateWidth * scale) / downscale));
      const scaledH = Math.max(6, Math.round((baseTemplateHeight * scale) / downscale));

      if (scaledW >= coarseW - 1 || scaledH >= coarseH - 1) {
        continue;
      }

      const scaledTemplate = templateJimp.clone().resize({ w: scaledW, h: scaledH });
      const tplData = scaledTemplate.bitmap.data;

      const match = this.colorNormalizedCrossCorrelation(
        screenData,
        coarseW,
        coarseH,
        tplData,
        scaledW,
        scaledH
      );

      if (match.score > bestScore) {
        bestScore = match.score;
        bestScale = scale;
        const actualW = Math.min(roiW, Math.round(baseTemplateWidth * scale));
        const actualH = Math.min(roiH, Math.round(baseTemplateHeight * scale));
        const localX = Math.min(Math.max(0, match.x * downscale), roiW - actualW);
        const localY = Math.min(Math.max(0, match.y * downscale), roiH - actualH);

        bestBox = {
          x: roiX + localX,
          y: roiY + localY,
          width: actualW,
          height: actualH
        };
      }
    }

    const found = bestScore >= threshold;
    const randomOffsetX = Math.floor(bestBox.width * (0.25 + Math.random() * 0.5));
    const randomOffsetY = Math.floor(bestBox.height * (0.25 + Math.random() * 0.5));
    const rawTargetX = bestBox.x + randomOffsetX;
    const rawTargetY = bestBox.y + randomOffsetY;
    const targetPoint = {
      x: options.region ? Math.min(options.region.maxX, Math.max(options.region.minX, rawTargetX)) : rawTargetX,
      y: options.region ? Math.min(options.region.maxY, Math.max(options.region.minY, rawTargetY)) : rawTargetY
    };

    const executionTimeMs = Date.now() - startTime;
    let visualDebugBase64: string | undefined;

    if (options.drawDebugBox) {
      try {
        visualDebugBase64 = await this.renderDebugOverlay(screenJimp, bestBox, targetPoint, bestScore, found);
      } catch (err) {
        // Overlay fallback
      }
    }

    return {
      found,
      score: Math.max(0, Math.min(1.0, bestScore)),
      box: bestBox,
      scale: bestScale,
      targetPoint,
      executionTimeMs,
      visualDebugBase64
    };
  }

  /**
   * Stores an in-memory PNG buffer directly in the template cache under a `ram://` key.
   */
  public static async setInMemoryTemplate(key: string, pngBuffer: Buffer): Promise<void> {
    const loaded = await Jimp.read(pngBuffer);
    this.multiTemplateCache.set(key, {
      mtimeMs: Date.now(),
      jimpImg: loaded,
      scaledMap: new Map()
    });
  }

  public static hasInMemoryTemplate(key: string): boolean {
    return this.multiTemplateCache.has(key);
  }

  /**
   * Fast RAM-based template matcher that operates directly on the raw RGBA buffer from `adb exec-out screencap`
   * without any PNG compression/decompression, caches all templates & scaled variants in a Map,
   * subsamples only the target region in a single pass, and checks 1.0x scale first with early exit.
   */
  public static async matchRaw(
    rawScreen: { data: Buffer | Uint8Array; width: number; height: number },
    templatePath: string,
    options: {
      scales?: number[];
      threshold?: number;
      region?: { minX: number; maxX: number; minY: number; maxY: number };
    } = {}
  ): Promise<MatchResult> {
    const startTime = Date.now();
    const threshold = options.threshold ?? 0.75;
    const rawScales = options.scales && options.scales.length > 0 ? options.scales : [1.0, 0.9, 1.1, 0.8, 1.25];
    // Always test 1.0x scale first for instant early exit
    const scales = [1.0, ...rawScales.filter((s) => Math.abs(s - 1.0) > 0.001)];

    let cached: { mtimeMs: number; jimpImg: any; scaledMap: Map<string, any> } | undefined;
    if (templatePath.startsWith('ram://')) {
      cached = this.multiTemplateCache.get(templatePath);
      if (!cached) {
        throw new Error(`In-memory RAM template not initialized: ${templatePath}`);
      }
    } else {
      const resolvedPath = path.resolve(process.cwd(), templatePath);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Template image not found at path: ${resolvedPath}`);
      }
      const stat = fs.statSync(resolvedPath);
      cached = this.multiTemplateCache.get(resolvedPath);
      if (!cached || cached.mtimeMs !== stat.mtimeMs) {
        const fileBuf = await fs.promises.readFile(resolvedPath);
        const loaded = await Jimp.read(fileBuf);
        cached = { mtimeMs: stat.mtimeMs, jimpImg: loaded, scaledMap: new Map() };
        this.multiTemplateCache.set(resolvedPath, cached);
      }
    }

    const screenWidth = rawScreen.width;
    const screenHeight = rawScreen.height;
    const fullData = rawScreen.data;

    const margin =
      options.region &&
      Math.min(options.region.maxX - options.region.minX, options.region.maxY - options.region.minY) < 140
        ? 18
        : 0;
    const roiX = options.region ? Math.max(0, Math.min(options.region.minX - margin, screenWidth - 16)) : 0;
    const roiY = options.region ? Math.max(0, Math.min(options.region.minY - margin, screenHeight - 16)) : 0;
    const roiW = options.region
      ? Math.max(16, Math.min(options.region.maxX + margin - roiX, screenWidth - roiX))
      : screenWidth;
    const roiH = options.region
      ? Math.max(16, Math.min(options.region.maxY + margin - roiY, screenHeight - roiY))
      : screenHeight;

    let baseTemplateWidth = cached.jimpImg.bitmap.width;
    let baseTemplateHeight = cached.jimpImg.bitmap.height;
    const maxAllowedW = Math.min(380, Math.floor(roiW * 0.9));
    const maxAllowedH = Math.min(380, Math.floor(roiH * 0.9));
    let normFactor = 1.0;
    if (baseTemplateWidth > maxAllowedW || baseTemplateHeight > maxAllowedH) {
      normFactor = Math.min(maxAllowedW / baseTemplateWidth, maxAllowedH / baseTemplateHeight);
      baseTemplateWidth = Math.max(12, Math.round(baseTemplateWidth * normFactor));
      baseTemplateHeight = Math.max(12, Math.round(baseTemplateHeight * normFactor));
    }

    const downscale =
      Math.min(baseTemplateWidth, baseTemplateHeight) <= 55 || Math.min(roiW, roiH) <= 140
        ? 2
        : options.region
        ? 3
        : Math.max(3, Math.round(roiW / 200));

    const coarseW = Math.max(16, Math.floor(roiW / downscale));
    const coarseH = Math.max(16, Math.floor(roiH / downscale));

    // Direct 1-pass stride slice from raw screen buffer (zero Jimp.read / zero Jimp.resize!)
    const screenData = new Uint8Array(coarseW * coarseH * 4);
    let dstIdx = 0;
    for (let cy = 0; cy < coarseH; cy++) {
      const sy = roiY + cy * downscale;
      const rowBase = sy * screenWidth;
      for (let cx = 0; cx < coarseW; cx++) {
        const sx = roiX + cx * downscale;
        const srcIdx = (rowBase + sx) * 4;
        screenData[dstIdx] = fullData[srcIdx];
        screenData[dstIdx + 1] = fullData[srcIdx + 1];
        screenData[dstIdx + 2] = fullData[srcIdx + 2];
        screenData[dstIdx + 3] = 255;
        dstIdx += 4;
      }
    }

    let bestScore = -1;
    let bestBox: MatchBoundingBox = {
      x: roiX + Math.max(0, Math.floor(roiW / 2 - baseTemplateWidth / 2)),
      y: roiY + Math.max(0, Math.floor(roiH / 2 - baseTemplateHeight / 2)),
      width: Math.min(roiW, baseTemplateWidth),
      height: Math.min(roiH, baseTemplateHeight)
    };
    let bestScale = 1.0;

    for (const scale of scales) {
      const scaledW = Math.max(6, Math.round((baseTemplateWidth * scale) / downscale));
      const scaledH = Math.max(6, Math.round((baseTemplateHeight * scale) / downscale));

      if (scaledW >= coarseW - 1 || scaledH >= coarseH - 1) {
        continue;
      }

      const cacheKey = `${scaledW}x${scaledH}`;
      let scaledTpl = cached.scaledMap.get(cacheKey);
      if (!scaledTpl) {
        const resized = cached.jimpImg.clone().resize({ w: scaledW, h: scaledH });
        scaledTpl = { w: scaledW, h: scaledH, data: resized.bitmap.data };
        cached.scaledMap.set(cacheKey, scaledTpl);
      }

      const match = this.colorNormalizedCrossCorrelation(
        screenData,
        coarseW,
        coarseH,
        scaledTpl.data,
        scaledW,
        scaledH
      );

      if (match.score > bestScore) {
        bestScore = match.score;
        bestScale = scale;
        const actualW = Math.min(roiW, Math.round(baseTemplateWidth * scale));
        const actualH = Math.min(roiH, Math.round(baseTemplateHeight * scale));
        const localX = Math.min(Math.max(0, match.x * downscale), roiW - actualW);
        const localY = Math.min(Math.max(0, match.y * downscale), roiH - actualH);

        bestBox = {
          x: roiX + localX,
          y: roiY + localY,
          width: actualW,
          height: actualH
        };

        // Early exit if 1.0x (or current scale) already has a strong match
        if (bestScore >= Math.max(threshold + 0.08, 0.84)) {
          break;
        }
      }
    }

    const found = bestScore >= threshold;
    const randomOffsetX = Math.floor(bestBox.width * (0.25 + Math.random() * 0.5));
    const randomOffsetY = Math.floor(bestBox.height * (0.25 + Math.random() * 0.5));
    const rawTargetX = bestBox.x + randomOffsetX;
    const rawTargetY = bestBox.y + randomOffsetY;
    const targetPoint = {
      x: options.region ? Math.min(options.region.maxX, Math.max(options.region.minX, rawTargetX)) : rawTargetX,
      y: options.region ? Math.min(options.region.maxY, Math.max(options.region.minY, rawTargetY)) : rawTargetY
    };

    return {
      found,
      score: Math.max(0, Math.min(1.0, bestScore)),
      box: bestBox,
      scale: bestScale,
      targetPoint,
      executionTimeMs: Date.now() - startTime
    };
  }

  private static colorNormalizedCrossCorrelation(
    img: Buffer | Uint8Array,
    imgW: number,
    imgH: number,
    tpl: Buffer | Uint8Array,
    tplW: number,
    tplH: number
  ): { x: number; y: number; score: number } {
    // Subsample template grid to at most ~12x12 points so correlation is O(1) per window
    const strideX = Math.max(1, Math.floor(tplW / 12));
    const strideY = Math.max(1, Math.floor(tplH / 12));

    const sampleOffsetsX: number[] = [];
    const sampleOffsetsY: number[] = [];
    for (let ty = 0; ty < tplH; ty += strideY) sampleOffsetsY.push(ty);
    for (let tx = 0; tx < tplW; tx += strideX) sampleOffsetsX.push(tx);

    const numSamples = sampleOffsetsX.length * sampleOffsetsY.length;
    if (numSamples === 0) return { x: 0, y: 0, score: 0 };

    const tplR = new Float32Array(numSamples);
    const tplG = new Float32Array(numSamples);
    const tplB = new Float32Array(numSamples);

    let sumR = 0, sumG = 0, sumB = 0;
    let sIdx = 0;
    for (let sy = 0; sy < sampleOffsetsY.length; sy++) {
      const ty = sampleOffsetsY[sy];
      for (let sx = 0; sx < sampleOffsetsX.length; sx++) {
        const tx = sampleOffsetsX[sx];
        const idx = (ty * tplW + tx) * 4;
        const r = tpl[idx];
        const g = tpl[idx + 1];
        const b = tpl[idx + 2];
        tplR[sIdx] = r;
        tplG[sIdx] = g;
        tplB[sIdx] = b;
        sumR += r;
        sumG += g;
        sumB += b;
        sIdx++;
      }
    }

    const meanR = sumR / numSamples;
    const meanG = sumG / numSamples;
    const meanB = sumB / numSamples;

    let tplVar = 0;
    for (let i = 0; i < numSamples; i++) {
      tplR[i] -= meanR;
      tplG[i] -= meanG;
      tplB[i] -= meanB;
      tplVar += tplR[i] * tplR[i] + tplG[i] * tplG[i] + tplB[i] * tplB[i];
    }
    const tplStd = Math.sqrt(tplVar);
    if (tplStd < 0.0001) return { x: 0, y: 0, score: 0 };

    const evalAt = (x: number, y: number): number => {
      let roiSumR = 0, roiSumG = 0, roiSumB = 0;
      for (let sy = 0; sy < sampleOffsetsY.length; sy++) {
        const rowBase = (y + sampleOffsetsY[sy]) * imgW + x;
        for (let sx = 0; sx < sampleOffsetsX.length; sx++) {
          const idx = (rowBase + sampleOffsetsX[sx]) * 4;
          roiSumR += img[idx];
          roiSumG += img[idx + 1];
          roiSumB += img[idx + 2];
        }
      }
      const rMean = roiSumR / numSamples;
      const gMean = roiSumG / numSamples;
      const bMean = roiSumB / numSamples;

      let cross = 0;
      let roiVar = 0;
      let k = 0;
      for (let sy = 0; sy < sampleOffsetsY.length; sy++) {
        const rowBase = (y + sampleOffsetsY[sy]) * imgW + x;
        for (let sx = 0; sx < sampleOffsetsX.length; sx++) {
          const idx = (rowBase + sampleOffsetsX[sx]) * 4;
          const dr = img[idx] - rMean;
          const dg = img[idx + 1] - gMean;
          const db = img[idx + 2] - bMean;
          roiVar += dr * dr + dg * dg + db * db;
          cross += dr * tplR[k] + dg * tplG[k] + db * tplB[k];
          k++;
        }
      }
      if (roiVar < 0.0001) return 0;
      return cross / (Math.sqrt(roiVar) * tplStd);
    };

    let bestScore = -1;
    let bestX = 0;
    let bestY = 0;

    // Pass 1: Coarse step=2 scan
    const step = 2;
    for (let y = 0; y <= imgH - tplH; y += step) {
      for (let x = 0; x <= imgW - tplW; x += step) {
        const score = evalAt(x, y);
        if (score > bestScore) {
          bestScore = score;
          bestX = x;
          bestY = y;
        }
      }
    }

    // Pass 2: 1px refinement around best coarse location
    const minY = Math.max(0, bestY - 2);
    const maxY = Math.min(imgH - tplH, bestY + 2);
    const minX = Math.max(0, bestX - 2);
    const maxX = Math.min(imgW - tplW, bestX + 2);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const score = evalAt(x, y);
        if (score > bestScore) {
          bestScore = score;
          bestX = x;
          bestY = y;
        }
      }
    }

    return { x: bestX, y: bestY, score: Math.max(0, bestScore) };
  }

  /**
   * Crops a specific X=[minX..maxX], Y=[minY..maxY] region from an image buffer.
   */
  public static async cropRegion(
    imageBuffer: Buffer,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number
  ): Promise<{ buffer: Buffer; width: number; height: number }> {
    const image = await Jimp.read(imageBuffer);
    const w = image.bitmap.width;
    const h = image.bitmap.height;

    const x0 = Math.max(0, Math.min(w - 1, Math.min(minX, maxX)));
    const x1 = Math.max(x0 + 1, Math.min(w, Math.max(minX, maxX)));
    const y0 = Math.max(0, Math.min(h - 1, Math.min(minY, maxY)));
    const y1 = Math.max(y0 + 1, Math.min(h, Math.max(minY, maxY)));

    const cropW = x1 - x0;
    const cropH = y1 - y0;

    image.crop({ x: x0, y: y0, w: cropW, h: cropH });
    const buffer = await image.getBuffer('image/png');
    return { buffer, width: cropW, height: cropH };
  }

  /**
   * Crops a region (or full screen) directly from a raw RGBA screen buffer and encodes only that region to PNG.
   */
  public static async cropRawToPng(
    rawScreen: { data: Buffer | Uint8Array; width: number; height: number },
    region?: { minX: number; maxX: number; minY: number; maxY: number }
  ): Promise<Buffer> {
    const sw = rawScreen.width;
    const sh = rawScreen.height;
    const cropX = region ? Math.max(0, Math.min(region.minX, sw - 1)) : 0;
    const cropY = region ? Math.max(0, Math.min(region.minY, sh - 1)) : 0;
    const cropW = region ? Math.max(1, Math.min(region.maxX - cropX, sw - cropX)) : sw;
    const cropH = region ? Math.max(1, Math.min(region.maxY - cropY, sh - cropY)) : sh;

    const croppedData = Buffer.alloc(cropW * cropH * 4);
    const srcData = rawScreen.data;
    for (let y = 0; y < cropH; y++) {
      const srcRowStart = ((cropY + y) * sw + cropX) * 4;
      const dstRowStart = y * cropW * 4;
      const copyLen = cropW * 4;
      if (srcRowStart + copyLen <= srcData.length) {
        if (Buffer.isBuffer(srcData)) {
          srcData.copy(croppedData, dstRowStart, srcRowStart, srcRowStart + copyLen);
        } else {
          croppedData.set(srcData.subarray(srcRowStart, srcRowStart + copyLen), dstRowStart);
        }
      }
    }

    const jimpCrop = Jimp.fromBitmap({
      data: croppedData,
      width: cropW,
      height: cropH
    });
    return await jimpCrop.getBuffer('image/png');
  }

  /**
   * Crops center width x height directly from a raw RGBA screen buffer and encodes to PNG.
   */
  public static async cropRawCenterToPng(
    rawScreen: { data: Buffer | Uint8Array; width: number; height: number },
    cropWidth = 150,
    cropHeight = 150
  ): Promise<Buffer> {
    const minX = Math.max(0, Math.floor((rawScreen.width - cropWidth) / 2));
    const minY = Math.max(0, Math.floor((rawScreen.height - cropHeight) / 2));
    return await this.cropRawToPng(rawScreen, {
      minX,
      maxX: minX + cropWidth,
      minY,
      maxY: minY + cropHeight
    });
  }

  /**
   * Crops exactly width x height pixels from the center of an image buffer.
   */
  public static async cropCenter(imageBuffer: Buffer, cropWidth = 150, cropHeight = 150): Promise<Buffer> {
    const image = await Jimp.read(imageBuffer);
    const w = image.bitmap.width;
    const h = image.bitmap.height;

    const left = Math.max(0, Math.floor((w - cropWidth) / 2));
    const top = Math.max(0, Math.floor((h - cropHeight) / 2));
    const finalW = Math.min(w, cropWidth);
    const finalH = Math.min(h, cropHeight);

    image.crop({ x: left, y: top, w: finalW, h: finalH });
    return await image.getBuffer('image/png');
  }

  /**
   * Draws a bounding box on the image using Jimp.
   */
  public static async renderDebugOverlay(
    screenJimp: any,
    box: MatchBoundingBox,
    target: { x: number; y: number },
    score: number,
    found: boolean
  ): Promise<string> {
    const debugImg = screenJimp.clone();
    const color = (found ? 0x10b981ff : 0xef4444ff) >>> 0;

    // Draw box rectangle border
    const border = 4;
    for (let b = 0; b < border; b++) {
      for (let x = box.x; x < box.x + box.width; x++) {
        if (x < debugImg.bitmap.width && box.y + b < debugImg.bitmap.height) {
          debugImg.setPixelColor(color, x, box.y + b);
        }
        if (x < debugImg.bitmap.width && box.y + box.height - 1 - b < debugImg.bitmap.height) {
          debugImg.setPixelColor(color, x, box.y + box.height - 1 - b);
        }
      }
      for (let y = box.y; y < box.y + box.height; y++) {
        if (box.x + b < debugImg.bitmap.width && y < debugImg.bitmap.height) {
          debugImg.setPixelColor(color, box.x + b, y);
        }
        if (box.x + box.width - 1 - b < debugImg.bitmap.width && y < debugImg.bitmap.height) {
          debugImg.setPixelColor(color, box.x + box.width - 1 - b, y);
        }
      }
    }

    // Draw target crosshair
    const crossSize = 15;
    const crossColor = 0xff0000ff >>> 0;
    for (let i = -crossSize; i <= crossSize; i++) {
      if (target.x + i >= 0 && target.x + i < debugImg.bitmap.width && target.y >= 0 && target.y < debugImg.bitmap.height) {
        debugImg.setPixelColor(crossColor, target.x + i, target.y);
      }
      if (target.x >= 0 && target.x < debugImg.bitmap.width && target.y + i >= 0 && target.y + i < debugImg.bitmap.height) {
        debugImg.setPixelColor(crossColor, target.x, target.y + i);
      }
    }

    const buf = await debugImg.getBuffer('image/jpeg');
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }
}
