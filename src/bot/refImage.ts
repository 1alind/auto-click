import fs from 'fs';
import path from 'path';
import { Jimp } from 'jimp';
import { StoragePaths } from './storagePaths';

export function resolveAutoclickDir(): string {
  return StoragePaths.getImagesDir();
}

export class RefImageManager {
  public static getRefDir(): string {
    return StoragePaths.getImagesDir();
  }

  public static getRefPath(): string {
    const resolved = StoragePaths.resolveImage('pfp');
    if (resolved) return resolved;
    return path.join(StoragePaths.getImagesDir(), 'pfp.png');
  }

  public static async ensureRefImage(): Promise<string> {
    const currentPath = this.getRefPath();
    if (fs.existsSync(currentPath)) {
      return currentPath;
    }

    const dir = path.dirname(currentPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await this.generateDefaultPfp(currentPath);
    return currentPath;
  }

  public static async getRefBuffer(): Promise<Buffer> {
    const refPath = await this.ensureRefImage();
    return await fs.promises.readFile(refPath);
  }

  public static async getRefBase64(): Promise<string> {
    const buf = await this.getRefBuffer();
    return `data:image/png;base64,${buf.toString('base64')}`;
  }

  public static async saveRefImage(buffer: Buffer): Promise<void> {
    const targetDir = this.getRefDir();
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const targetPath = path.join(targetDir, 'pfp.png');
    const img = await Jimp.read(buffer);
    const pngBuf = await img.getBuffer('image/png');
    await fs.promises.writeFile(targetPath, pngBuf);
  }

  public static async generateDefaultPfp(targetFile?: string): Promise<void> {
    const outPath = targetFile || this.getRefPath();
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const size = 128;
    const img = new Jimp({ width: size, height: size, color: 0x6366f1ff });

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = Math.floor(99 + (x / size) * 120);
        const g = Math.floor(102 - (y / size) * 40);
        const b = Math.floor(241 - (x / size) * 50);

        const dx = x - size / 2;
        const dy = y - size / 2;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 40) {
          const hex = 0xffffffff;
          img.setPixelColor(hex, x, y);
        } else {
          const colorHex = (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | 0xff) >>> 0;
          img.setPixelColor(colorHex, x, y);
        }
      }
    }

    const pngBuf = await img.getBuffer('image/png');
    await fs.promises.writeFile(outPath, pngBuf);
  }
}
