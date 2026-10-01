import { exec } from 'child_process';
import util from 'util';
import { WebhookService } from './webhook';
import { CrashHandler } from './crashHandler';
import { ConsoleLogger } from './consoleLogger';

const execPromise = util.promisify(exec);

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentCommit: string;
  latestCommit: string;
  commitMessage?: string;
  behindByCount?: number;
  branch: string;
  error?: string;
}

export interface AutoUpdaterOptions {
  webhookService?: WebhookService;
  githubToken?: string;
  githubRepo?: string;
  onLog?: (msg: string, level: string, data?: any) => void;
}

export class AutoUpdater {
  private timer: NodeJS.Timeout | null = null;
  private isUpdating = false;
  private webhookService: WebhookService | null = null;
  private githubToken: string = '';
  private githubRepo: string = 'https://github.com/1alind/auto-click';
  private onLogCallback?: (msg: string, level: string, data?: any) => void;

  constructor(options?: AutoUpdaterOptions) {
    if (options?.webhookService) this.webhookService = options.webhookService;
    if (options?.githubToken) this.githubToken = options.githubToken;
    if (options?.githubRepo) this.githubRepo = options.githubRepo;
    if (options?.onLog) this.onLogCallback = options.onLog;
  }

  public setWebhookService(webhook: WebhookService): void {
    this.webhookService = webhook;
  }

  public setGitHubToken(token: string): void {
    this.githubToken = token;
  }

  public setGitHubRepo(repo: string): void {
    this.githubRepo = repo;
  }

  public getGitHubToken(): string {
    if (this.githubToken) return this.githubToken;
    if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

    // Check JSON config files on disk
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const homeDir = process.env.HOME || os.homedir() || '';
      const candidatePaths = [
        path.resolve(homeDir, 'storage/shared/autoclick/auto-click.json'),
        '/sdcard/autoclick/auto-click.json',
        '/storage/emulated/0/autoclick/auto-click.json',
        path.resolve(homeDir, 'storage/shared/auto-click.json'),
        '/sdcard/auto-click.json',
        path.resolve(process.cwd(), 'auto-click.json'),
        path.resolve(process.cwd(), 'bot-config.json')
      ];
      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
          const token =
            parsed.GH_TOKEN ||
            parsed.gh_token ||
            parsed.GITHUB_TOKEN ||
            parsed.github_token ||
            parsed.githubToken;
          if (token && typeof token === 'string' && token.trim()) {
            this.githubToken = token.trim();
            return this.githubToken;
          }
        }
      }
    } catch {
      // ignore
    }

    return '';
  }

  /**
   * Sanitizes strings to prevent leaking GitHub Personal Access Tokens in logs or webhooks.
   */
  public sanitize(text: string): string {
    if (!text) return '';
    return text
      .replace(/https:\/\/[^@\s/]+@github\.com/gi, 'https://***@github.com')
      .replace(/ghp_[a-zA-Z0-9_]{10,}/gi, 'ghp_***')
      .replace(/github_pat_[a-zA-Z0-9_]{15,}/gi, 'github_pat_***');
  }

  /**
   * Ensures the Git remote origin is configured with credentials for private repository access.
   */
  public async ensureRemoteConfigured(): Promise<string> {
    const token = this.getGitHubToken().trim();
    let repo = this.githubRepo.trim() || 'https://github.com/1alind/auto-click';

    // Extract owner/repo name (e.g. "1alind/auto-click")
    let cleanRepo = repo
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/^git@github\.com:/i, '')
      .replace(/\.git$/i, '')
      .trim();

    if (!cleanRepo || !cleanRepo.includes('/')) {
      cleanRepo = '1alind/auto-click';
    }

    const authenticatedUrl = token
      ? `https://${token}@github.com/${cleanRepo}.git`
      : `https://github.com/${cleanRepo}.git`;

    try {
      // Prevent git from ever hanging or asking for interactive prompts
      await execPromise('git config --global core.askPass ""').catch(() => {});
      await execPromise('git config --global credential.helper ""').catch(() => {});
      const { stdout: remoteUrl } = await execPromise('git config --get remote.origin.url');
      if (remoteUrl.trim() !== authenticatedUrl) {
        await execPromise(`git remote set-url origin ${authenticatedUrl}`);
        this.log(
          `🔗 Git remote origin updated (${token ? 'Private Repo Authenticated with Token' : 'Public/Default'})`,
          'info'
        );
      }
    } catch {
      try {
        await execPromise(`git remote add origin ${authenticatedUrl}`);
        this.log(
          `🔗 Git remote origin added (${token ? 'Private Repo Authenticated with Token' : 'Public/Default'})`,
          'info'
        );
      } catch {
        // remote already configured or error ignored
      }
    }

    return authenticatedUrl;
  }

  /**
   * Starts periodic GitHub update checks. Strictly runs every 1 minute.
   */
  public startPeriodicCheck(intervalMinutes = 1, autoPull = true): void {
    this.stopPeriodicCheck();
    const intervalMs = 60 * 1000; // Strictly 1 minute (60,000ms)

    // Run initial check after 2 seconds of startup
    setTimeout(async () => {
      this.log('🔍 Checking GitHub for updates (startup check)...', 'info');
      await this.checkAndApplyUpdateIfAvailable(autoPull);
    }, 2000);

    this.timer = setInterval(async () => {
      this.log('🔍 Checking GitHub for updates (1-minute periodic check)...', 'info');
      await this.checkAndApplyUpdateIfAvailable(autoPull);
    }, intervalMs);

    this.log('⏱️ Auto-updater active (checking GitHub every 1 min)...', 'info');
  }

  public stopPeriodicCheck(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Checks Git remote for new commits.
   */
  public async checkForUpdates(): Promise<UpdateCheckResult> {
    try {
      // Check if git is available in directory
      const { stdout: currentCommitRaw } = await execPromise('git rev-parse --short HEAD');
      const currentCommit = currentCommitRaw.trim();

      const { stdout: branchRaw } = await execPromise('git rev-parse --abbrev-ref HEAD');
      const branch = branchRaw.trim() || 'main';

      // Ensure remote origin is configured with token authentication
      await this.ensureRemoteConfigured();

      const token = this.getGitHubToken().trim();
      const gitEnv = {
        ...process.env,
        GH_TOKEN: token,
        GITHUB_TOKEN: token,
        GIT_TERMINAL_PROMPT: '0'
      };

      // Fetch remote updates (with 30s timeout so offline network never hangs forever)
      await execPromise('git -c credential.helper= -c core.askPass= fetch origin', {
        env: gitEnv,
        timeout: 30000
      });

      // Check remote commit
      const { stdout: remoteCommitRaw } = await execPromise(`git rev-parse --short origin/${branch}`);
      const latestCommit = remoteCommitRaw.trim();

      // Check how many commits behind
      let behindByCount = 0;
      let commitMessage = '';
      try {
        const { stdout: countRaw } = await execPromise(`git rev-list --count HEAD..origin/${branch}`);
        behindByCount = parseInt(countRaw.trim(), 10) || 0;

        if (behindByCount > 0) {
          const { stdout: logRaw } = await execPromise(`git log -1 --pretty=format:"%s (%an)" origin/${branch}`);
          commitMessage = logRaw.trim();
        }
      } catch {
        behindByCount = currentCommit !== latestCommit ? 1 : 0;
      }

      const updateAvailable = currentCommit !== latestCommit && behindByCount > 0;

      return {
        updateAvailable,
        currentCommit,
        latestCommit,
        commitMessage,
        behindByCount,
        branch
      };
    } catch (err: any) {
      const sanitizedError = this.sanitize(err.message || String(err));
      let helpfulError = sanitizedError;

      if (
        sanitizedError.toLowerCase().includes('authentication failed') ||
        sanitizedError.toLowerCase().includes('could not read username') ||
        sanitizedError.toLowerCase().includes('access denied') ||
        sanitizedError.toLowerCase().includes('repository not found')
      ) {
        helpfulError = 'Private repository authentication required. Please set your GitHub Token in bot-config.json or run "!settoken <token>".';
      }

      return {
        updateAvailable: false,
        currentCommit: 'unknown',
        latestCommit: 'unknown',
        branch: 'main',
        error: helpfulError
      };
    }
  }

  /**
   * Automatically pulls latest changes and triggers restart.
   */
  public async checkAndApplyUpdateIfAvailable(autoPull = true): Promise<UpdateCheckResult> {
    const check = await this.checkForUpdates();

    if (check.error) {
      this.log(`⚠️ GitHub connect failed (${check.error}) — will retry in 1 minute...`, 'info');
      if (!this.timer) {
        this.startPeriodicCheck(1, autoPull);
      }
      return check;
    }

    if (check.updateAvailable) {
      this.log(
        `🚀 New GitHub update detected! ${check.behindByCount} new commit(s). Remote: ${check.latestCommit}, Local: ${check.currentCommit}`,
        'info',
        check
      );

      if (autoPull && !this.isUpdating) {
        await this.pullAndRestart(check, true);
      }
    } else {
      this.log(`✅ Bot is up to date (Commit: ${check.currentCommit} on branch ${check.branch}).`, 'info');
    }

    return check;
  }

  /**
   * Pulls latest code from private or public GitHub repo and restarts application.
   */
  public async pullAndRestart(updateInfo?: UpdateCheckResult, isAuto = false): Promise<{ success: boolean; message: string }> {
    if (this.isUpdating) {
      return { success: false, message: 'Update already in progress.' };
    }
    this.isUpdating = true;

    try {
      const { MacroManager } = await import('./macroManager');
      if (MacroManager.isFindRunning()) {
        this.log('⏳ Update waiting for "find" to finish completely...', 'info');
        await MacroManager.waitForFind();
      }
      if (MacroManager.getRunningMacro()) {
        this.log('⏳ Update waiting for running macro to pause at safe step boundary (1, 7, or 13) and save state to SD card...', 'info');
        await MacroManager.stopForUpdateAndWait();
      }

      this.log('📥 Pulling latest updates from private GitHub repo via git pull...', 'info');

      // Ensure remote origin is configured with token
      await this.ensureRemoteConfigured();

      const token = this.getGitHubToken().trim();
      const gitEnv = {
        ...process.env,
        GH_TOKEN: token,
        GITHUB_TOKEN: token,
        GIT_TERMINAL_PROMPT: '0'
      };

      // Execute git pull (with 30s timeout so offline network never hangs forever)
      const { stdout: pullOut } = await execPromise('git -c credential.helper= -c core.askPass= pull', {
        env: gitEnv,
        timeout: 30000
      });
      this.log(`Git pull output: ${this.sanitize(pullOut.trim())}`, 'info');

      // Auto run npm i whenever files are updated
      this.log('📦 Files updated: Running "npm i --legacy-peer-deps" to ensure all packages and dependencies are synchronized...', 'info');
      try {
        const { stdout: npmOut } = await execPromise('npm i --legacy-peer-deps --no-audit --no-fund');
        this.log(`📦 npm i completed: ${this.sanitize(npmOut.trim().slice(0, 200))}`, 'info');
      } catch (npmErr: any) {
        this.log(`⚠️ npm i warning: ${this.sanitize(npmErr.message)}`, 'warn');
      }

      ConsoleLogger.updated();
      this.log('✅ Update applied successfully with dependencies installed. Restarting bot now...', 'info');

      setTimeout(() => {
        CrashHandler.restartProcess();
      }, 1500);

      return { success: true, message: 'updated' };
    } catch (err: any) {
      this.isUpdating = false;
      const cleanMsg = this.sanitize(err.message || String(err));
      const errorMsg = `update failed: ${cleanMsg} — retrying in 1 minute...`;
      ConsoleLogger.error(cleanMsg, 'git update');
      this.log(errorMsg, 'error');

      // Schedule automatic 1-minute retry when GitHub pull fails
      setTimeout(() => {
        if (!this.isUpdating) {
          this.log('🔄 Retrying GitHub update pull (1-minute retry)...', 'info');
          this.pullAndRestart(updateInfo, isAuto).catch(() => {});
        }
      }, 60 * 1000);

      if (!isAuto && this.webhookService && this.webhookService.isConfigured()) {
        await this.webhookService
          .send({
            content: errorMsg
          })
          .catch(() => {});
      }

      return { success: false, message: errorMsg };
    }
  }

  private log(msg: string, level = 'info', data?: any): void {
    const cleanMsg = this.sanitize(msg);
    if (this.onLogCallback) {
      this.onLogCallback(cleanMsg, level, data);
    }
  }
}
