import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Centralized Persistent Storage Manager for SDCard / Termux
 * Organizes files into clean dedicated subdirectories:
 * - sdcard/autoclick/images/   -> Reference & template images (fleet.png, crops, pfp, etc.)
 * - sdcard/autoclick/macros/   -> Custom macros (custom-macros.json, start-state.json)
 * - sdcard/autoclick/rules/    -> Screen recognition rules (screen_rules.json, unknown screenshots)
 * - sdcard/autoclick/config/   -> Bot config (auto-click.json, bot-config.json)
 * - sdcard/autoclick/logs/     -> Logs & crash reports
 */
export class StoragePaths {
  private static cachedBaseDir: string | null = null;

  /**
   * Resolves the root autoclick directory on Android / Termux or falls back to data/
   */
  public static getBaseDir(): string {
    if (this.cachedBaseDir && fs.existsSync(this.cachedBaseDir)) {
      return this.cachedBaseDir;
    }

    const homeDir = process.env.HOME || os.homedir() || '';
    const candidateBases = [
      path.resolve(homeDir, 'storage/shared/autoclick'),
      '/sdcard/autoclick',
      '/storage/emulated/0/autoclick',
      path.resolve(process.cwd(), 'data/autoclick')
    ];

    for (const base of candidateBases) {
      const parent = path.dirname(base);
      if (fs.existsSync(parent) || fs.existsSync(base)) {
        try {
          fs.mkdirSync(base, { recursive: true });
          this.cachedBaseDir = base;
          return base;
        } catch {}
      }
    }

    const fallback = path.resolve(process.cwd(), 'data/autoclick');
    fs.mkdirSync(fallback, { recursive: true });
    this.cachedBaseDir = fallback;
    return fallback;
  }

  public static getImagesDir(): string {
    const dir = path.join(this.getBaseDir(), 'images');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  public static getMacrosDir(): string {
    const dir = path.join(this.getBaseDir(), 'macros');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  public static getRulesDir(): string {
    const dir = path.join(this.getBaseDir(), 'rules');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  public static getConfigDir(): string {
    const dir = path.join(this.getBaseDir(), 'config');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  public static getDashboardMessagePath(): string {
    return path.join(this.getConfigDir(), 'dashboard-message.json');
  }

  public static getChannelIdPath(): string {
    return path.join(this.getConfigDir(), 'channel-id.json');
  }

  public static getChannelStatusPath(): string {
    return path.join(this.getConfigDir(), 'channel-status.json');
  }

  public static getLogsDir(): string {
    const dir = path.join(this.getBaseDir(), 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Initializes all subdirectories and migrates existing root files if present
   */
  public static init(): void {
    const base = this.getBaseDir();
    const imagesDir = this.getImagesDir();
    const macrosDir = this.getMacrosDir();
    const rulesDir = this.getRulesDir();
    const configDir = this.getConfigDir();
    this.getLogsDir();

    try {
      // Migrate root screen_rules.json -> rules/screen_rules.json
      const legacyRules = path.join(base, 'screen_rules.json');
      const targetRules = path.join(rulesDir, 'screen_rules.json');
      if (fs.existsSync(legacyRules) && !fs.existsSync(targetRules)) {
        fs.copyFileSync(legacyRules, targetRules);
      }

      // Migrate root custom-macros.json -> macros/custom-macros.json
      const legacyMacros = path.join(base, 'custom-macros.json');
      const targetMacros = path.join(macrosDir, 'custom-macros.json');
      if (fs.existsSync(legacyMacros) && !fs.existsSync(targetMacros)) {
        fs.copyFileSync(legacyMacros, targetMacros);
      }

      // Migrate root start-state.json -> macros/start-state.json
      const legacyStartState = path.join(base, 'start-state.json');
      const targetStartState = path.join(macrosDir, 'start-state.json');
      if (fs.existsSync(legacyStartState) && !fs.existsSync(targetStartState)) {
        fs.copyFileSync(legacyStartState, targetStartState);
      }

      // Migrate root auto-click.json -> config/auto-click.json
      const legacyConfig = path.join(base, 'auto-click.json');
      const targetConfig = path.join(configDir, 'auto-click.json');
      if (fs.existsSync(legacyConfig) && !fs.existsSync(targetConfig)) {
        fs.copyFileSync(legacyConfig, targetConfig);
      }
    } catch (err: any) {
      console.warn('[StoragePaths] Migration check non-fatal error:', err.message);
    }
  }

  /**
   * Resolves an image path by searching in:
   * 1. sdcard/autoclick/images/ (Primary)
   * 2. sdcard/autoclick/ (Legacy root)
   * 3. Working directory
   */
  public static resolveImage(imageName: string): string | null {
    const clean = imageName.trim();
    if (!clean) return null;

    const hasExt = /\.[a-z0-9]+$/i.test(clean);
    const variants = hasExt ? [clean] : [clean, `${clean}.png`, `${clean}.jpg`, `${clean}.jpeg`];

    const searchDirs = [
      this.getImagesDir(),
      this.getBaseDir(),
      path.resolve(this.getBaseDir(), '../'),
      process.cwd()
    ];

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const variant of variants) {
        const candidate = path.resolve(dir, variant);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    return null;
  }

  /**
   * Returns list of all images across images/ folder and legacy base folder
   */
  public static getAllImages(): Array<{ name: string; fullPath: string; folder: string }> {
    const results: Array<{ name: string; fullPath: string; folder: string }> = [];
    const seen = new Set<string>();

    const checkFolder = (dir: string, folderLabel: string) => {
      if (!fs.existsSync(dir)) return;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (/\.(png|jpe?g|webp|bmp)$/i.test(file)) {
            const fullPath = path.join(dir, file);
            if (!seen.has(file.toLowerCase())) {
              seen.add(file.toLowerCase());
              results.push({ name: file, fullPath, folder: folderLabel });
            }
          }
        }
      } catch {}
    };

    checkFolder(this.getImagesDir(), 'images');
    checkFolder(this.getBaseDir(), 'autoclick');

    return results;
  }

  /**
   * Returns primary path for screen_rules.json
   */
  public static getRulesPath(): string {
    const primary = path.join(this.getRulesDir(), 'screen_rules.json');
    if (fs.existsSync(primary)) return primary;
    const legacy = path.join(this.getBaseDir(), 'screen_rules.json');
    if (fs.existsSync(legacy)) return legacy;
    return primary;
  }

  /**
   * Returns primary path for custom-macros.json
   */
  public static getMacrosPath(): string {
    const primary = path.join(this.getMacrosDir(), 'custom-macros.json');
    if (fs.existsSync(primary)) return primary;
    const legacy = path.join(this.getBaseDir(), 'custom-macros.json');
    if (fs.existsSync(legacy)) return legacy;
    return primary;
  }

  /**
   * Returns primary path for start-state.json
   */
  public static getStartStatePath(): string {
    const primary = path.join(this.getMacrosDir(), 'start-state.json');
    if (fs.existsSync(primary)) return primary;
    const legacy = path.join(this.getBaseDir(), 'start-state.json');
    if (fs.existsSync(legacy)) return legacy;
    return primary;
  }

  /**
   * Returns primary path for auto-click.json
   */
  public static getConfigPath(): string {
    const inConfig = path.join(this.getConfigDir(), 'auto-click.json');
    if (fs.existsSync(inConfig)) return inConfig;
    const inBase = path.join(this.getBaseDir(), 'auto-click.json');
    if (fs.existsSync(inBase)) return inBase;
    return inConfig;
  }
}

StoragePaths.init();
