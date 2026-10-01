import fs from 'fs';
import path from 'path';
import os from 'os';
import { Jimp } from 'jimp';

export function resolveAutoclickDir(): string {
  const homeDir = process.env.HOME || os.homedir() || '';
  const candidates = [
    path.resolve(homeDir, 'storage/shared/autoclick'),
    '/sdcard/autoclick',
    '/storage/emulated/0/autoclick'
  ];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }

  const sharedBase = path.resolve(homeDir, 'storage/shared');
  if (fs.existsSync(sharedBase) || process.env.TERMUX_VERSION || process.env.PREFIX?.includes('com.termux')) {
    return path.resolve(homeDir, 'storage/shared/autoclick');
  }

  if (fs.existsSync('/sdcard')) return '/sdcard/autoclick';
  if (fs.existsSync('/storage/emulated/0')) return '/storage/emulated/0/autoclick';

  return path.resolve(process.cwd(), 'ref');
}

export class RefImageManager {
  public static getRefDir(): string {
    return resolveAutoclickDir();
  }

  public static getRefPath(): string {
    const homeDir = process.env.HOME || os.homedir() || '';
    const searchDirs = [
      path.resolve(homeDir, 'storage/shared/autoclick'),
      '/sdcard/autoclick',
      '/storage/emulated/0/autoclick',
      path.resolve(process.cwd(), 'ref')
    ];

    const preferredNames = ['pfp.jpg', 'pfp.jpeg', 'pfp.png', 'pfp.bmp'];

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const name of preferredNames) {
        const full = path.join(dir, name);
        if (fs.existsSync(full)) return full;
      }
      try {
        const files = fs.readdirSync(dir);
        const match = files.find((f) => /^pfp\.(jpg|jpeg|png|bmp)$/i.test(f));
        if (match) return path.join(dir, match);
      } catch {
        // ignore
      }
    }

    return path.join(this.getRefDir(), 'pfp.jpg');
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
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }

  public static async saveRefImage(buffer: Buffer): Promise<void> {
    const targetDir = this.getRefDir();
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const targetPath = path.join(targetDir, 'pfp.jpg');
    const img = await Jimp.read(buffer);
    const jpegBuf = await img.getBuffer('image/jpeg');
    await fs.promises.writeFile(targetPath, jpegBuf);
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

    const jpegBuf = await img.getBuffer('image/jpeg');
    await fs.promises.writeFile(outPath, jpegBuf);
  }
}
