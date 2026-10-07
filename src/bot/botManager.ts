import fs from 'fs';
import path from 'path';
import os from 'os';
import { BotConfig, BotLogEntry, CommandDefinition, CommandResult, StepLog } from './types';
import { AdbController } from './adb';
import { WebhookService } from './webhook';
import { DiscordBotClient } from './discordBot';
import { findCommand } from './commands/find';
import { fixacCommand, textsCommand } from './commands/fixac';
import { subCommand } from './commands/sub';
import { aiCommand } from './commands/ai';
import { moveCommand } from './commands/move';
import {
  tapCommand,
  screenshotCommand,
  devicesCommand,
  statusCommand,
  helpCommand,
  updateCommand,
  checkUpdateCommand,
  setTokenCommand,
  restartCommand,
  crashTestCommand,
  connectCommand,
  pairCommand,
  macroCommand,
  imagesCommand,
  stopCommand,
  testCommand,
  liveCommand,
  clearCommand
} from './commands/index';
import { RefImageManager } from './refImage';
import { CrashHandler } from './crashHandler';
import { AutoUpdater } from './autoUpdater';
import { ConsoleLogger } from './consoleLogger';
import { StoragePaths } from './storagePaths';

export function resolveConfigFilePath(): string {
  return StoragePaths.getConfigPath();
}

export class BotManager {
  private static instance: BotManager;
  private config: BotConfig;
  private configPath: string = '';
  private adb: AdbController;
  private webhook: WebhookService;
  private discord: DiscordBotClient;
  private autoUpdater: AutoUpdater;
  private logs: BotLogEntry[] = [];
  private maxLogs = 200;
  private listeners: ((log: BotLogEntry) => void)[] = [];
  private stepListeners: ((step: StepLog) => void)[] = [];

  private constructor() {
    this.config = this.loadConfig();
    this.adb = new AdbController({
      serial: this.config.adbSerial,
      host: this.config.adbHost
    });
    this.webhook = new WebhookService(this.config.webhookUrl);
    this.discord = new DiscordBotClient({
      token: this.config.discordToken,
      prefix: this.config.prefix,
      onLog: (msg, level, data) => this.addLog(msg, level as any, data)
    });

    // Initialize Auto-Updater and Crash Guardian
    this.autoUpdater = new AutoUpdater({
      webhookService: this.webhook,
      githubToken: this.config.githubToken,
      githubRepo: this.config.githubRepo,
      onLog: (msg, level, data) => this.addLog(msg, level as any, data)
    });

    if (this.config.autoRestartOnCrash) {
      CrashHandler.init(this.webhook, (err) => {
        this.addLog(`🚨 CRASH HANDLER: ${err.message}`, 'error');
      });
    }

    this.registerDefaultCommands();
    RefImageManager.ensureRefImage().catch((err) => ConsoleLogger.error(err, 'ref image'));

    if (this.config.adbHost) {
      this.adb.connectTcp(this.config.adbHost).catch(() => {});
    }

    if (this.config.autoStartBot && this.config.discordToken) {
      this.discord.start(this.config.discordToken).catch((err) => {
        this.addLog(`Auto-start failed: ${err.message}`, 'warn');
      });
    }
  }

  public static getInstance(): BotManager {
    if (!BotManager.instance) {
      BotManager.instance = new BotManager();
    }
    return BotManager.instance;
  }

  private registerDefaultCommands(): void {
    this.discord.registerCommand(findCommand);
    this.discord.registerCommand(fixacCommand);
    this.discord.registerCommand(textsCommand);
    this.discord.registerCommand(subCommand);
    this.discord.registerCommand(tapCommand);
    this.discord.registerCommand(screenshotCommand);
    this.discord.registerCommand(devicesCommand);
    this.discord.registerCommand(statusCommand);
    this.discord.registerCommand(helpCommand);
    this.discord.registerCommand(updateCommand);
    this.discord.registerCommand(checkUpdateCommand);
    this.discord.registerCommand(setTokenCommand);
    this.discord.registerCommand(restartCommand);
    this.discord.registerCommand(crashTestCommand);
    this.discord.registerCommand(connectCommand);
    this.discord.registerCommand(pairCommand);
    this.discord.registerCommand(macroCommand);
    this.discord.registerCommand(imagesCommand);
    this.discord.registerCommand(stopCommand);
    this.discord.registerCommand(testCommand);
    this.discord.registerCommand(liveCommand);
    this.discord.registerCommand(aiCommand);
    this.discord.registerCommand(moveCommand);
    this.discord.registerCommand(clearCommand);

    // Load and register all saved custom macros as direct commands (e.g. "start")
    import('./macroManager').then(({ MacroManager }) => {
      MacroManager.init();
      for (const macro of MacroManager.getMacros()) {
        this.discord.registerCommand({
          name: macro.name,
          description: `Custom macro flow "${macro.name}" (${macro.steps.length} steps)`,
          usage: `${macro.name}`,
          execute: async (c) => {
            const latest = MacroManager.getMacro(macro.name) || macro;
            return await MacroManager.executeMacro(latest, c);
          }
        });
      }
    }).catch(() => {});

    // Automatically scan 127.0.0.1:30000-40000 with nmap and connect on script startup without waiting for `connect` command
    setTimeout(async () => {
      try {
        const avail = await this.adb.isAdbAvailable();
        if (!avail) return;
        const devices = await this.adb.getDevices();
        const onlineLocal = devices.find((d) => d.state === 'device' && d.serial.startsWith('127.0.0.1:'));
        if (onlineLocal) {
          this.adb.setSerial(onlineLocal.serial);
          this.adb.setHost(onlineLocal.serial);
          this.adb.startWifiDebuggingWatcher();
          if (this.webhook.isConfigured()) {
            await this.webhook.send({ content: `connected to ${onlineLocal.serial}` }).catch(() => {});
          }
        } else {
          this.adb.startBackgroundAutoConnect();
        }
      } catch {
        // ignore startup scan error
      }
    }, 1500);
  }

  public registerCommand(cmd: CommandDefinition): void {
    this.discord.registerCommand(cmd);
    this.addLog(`Registered custom command: ${cmd.name}`, 'info');
  }

  public getCommands(): CommandDefinition[] {
    return this.discord.getCommands();
  }

  public getAdbController(): AdbController {
    return this.adb;
  }

  public getWebhookService(): WebhookService {
    return this.webhook;
  }

  public getDiscordBot(): DiscordBotClient {
    return this.discord;
  }

  public getAutoUpdater(): AutoUpdater {
    return this.autoUpdater;
  }

  public getConfig(): BotConfig {
    return { ...this.config };
  }

  public updateConfig(newConfig: Partial<BotConfig>): BotConfig {
    this.config = {
      ...this.config,
      ...newConfig
    };

    if (newConfig.adbSerial !== undefined) this.adb.setSerial(newConfig.adbSerial);
    if (newConfig.adbHost !== undefined) this.adb.setHost(newConfig.adbHost);
    if (newConfig.githubToken !== undefined) this.autoUpdater.setGitHubToken(newConfig.githubToken);
    if (newConfig.githubRepo !== undefined) this.autoUpdater.setGitHubRepo(newConfig.githubRepo);
    if (newConfig.webhookUrl !== undefined) {
      this.webhook.setWebhookUrl(newConfig.webhookUrl);
      this.autoUpdater.setWebhookService(this.webhook);
      CrashHandler.setWebhookService(this.webhook);
    }

    if (newConfig.autoUpdate !== undefined || newConfig.updateCheckIntervalMinutes !== undefined) {
      if (this.config.autoUpdate) {
        this.autoUpdater.startPeriodicCheck(this.config.updateCheckIntervalMinutes || 1, true);
      } else {
        this.autoUpdater.stopPeriodicCheck();
      }
    }

    this.saveConfig();
    this.addLog('Bot configuration updated.', 'info');
    return this.config;
  }

  public async getStatus() {
    const devices = await this.adb.getDevices();
    const isAdbBinaryInstalled = await this.adb.isAdbAvailable();
    const connectedDevices = devices.filter((d) => d.state === 'device');
    const isAdbConnected = connectedDevices.length > 0;
    return {
      discordBotConnected: this.discord.isConnected(),
      discordUser: this.discord.getBotUser(),
      webhookConfigured: this.webhook.isConfigured(),
      webhookUrlMasked: this.maskWebhook(this.config.webhookUrl),
      adbAvailable: isAdbConnected,
      adbBinaryInstalled: isAdbBinaryInstalled,
      adbConnected: isAdbConnected,
      activeDevice: connectedDevices[0]?.serial || devices[0]?.serial || 'None',
      devices,
      commandsCount: this.discord.getCommands().length,
      prefix: this.config.prefix,
      matchThreshold: this.config.matchThreshold,
      scales: this.config.scales,
      simulatorFallback: this.config.useSimulatorFallback,
      autoUpdate: this.config.autoUpdate,
      autoRestartOnCrash: this.config.autoRestartOnCrash,
      updateCheckIntervalMinutes: this.config.updateCheckIntervalMinutes,
      uptimeSeconds: Math.floor(process.uptime())
    };
  }

  public addLog(message: string, level: 'info' | 'warn' | 'error' | 'step' | 'command' = 'info', data?: any): void {
    const entry: BotLogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toLocaleTimeString(),
      level,
      message,
      data
    };
    this.logs.unshift(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.pop();
    }
    this.listeners.forEach((l) => l(entry));
  }

  public getLogs(): BotLogEntry[] {
    return [...this.logs];
  }

  public clearLogs(): void {
    this.logs = [];
  }

  public emitStep(step: StepLog): void {
    this.stepListeners.forEach((l) => l(step));
  }

  public async executeCommand(name: string, args: string[] = []): Promise<CommandResult> {
    this.addLog(`Manually executing command: "${name}" [${args.join(' ')}]`, 'command');
    return await this.discord.executeCommandByName(name, args, {
      author: {
        id: 'web-dashboard',
        tag: 'DashboardUser#0001',
        username: 'DashboardUser'
      },
      notifyStep: (step, title, description, status = 'completed', data) => {
        this.emitStep({
          step,
          title,
          description,
          timestamp: Date.now(),
          status,
          data
        });
      }
    });
  }

  public getConfigFilePath(): string {
    return this.configPath || resolveConfigFilePath();
  }

  private loadConfig(): BotConfig {
    const defaults: BotConfig = {
      discordToken: process.env.DISCORD_BOT_TOKEN || '',
      webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
      prefix: '',
      adbSerial: '',
      adbHost: '',
      matchThreshold: 0.75,
      scales: [0.5, 0.7, 0.85, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0],
      autoStartBot: true,
      autoUpdate: false,
      githubRepo: 'https://github.com/1alind/auto-click',
      githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
      updateCheckIntervalMinutes: 1,
      autoRestartOnCrash: true
    };

    const targetPath = resolveConfigFilePath();
    this.configPath = targetPath;

    // Read and merge config from all possible paths, prioritizing non-empty values
    // to gracefully migrate existing configs (e.g. from bot-config.json) to ~/storage/shared/auto-click.json
    const homeDir = process.env.HOME || os.homedir() || '';
    const candidatePaths = [
      path.resolve(process.cwd(), 'bot-config.json'),
      path.resolve(process.cwd(), 'auto-click.json'),
      path.resolve(process.cwd(), 'config.json'),
      '/sdcard/auto-click.json',
      '/sdcard/autoclick.json',
      '/sdcard/config.json',
      '/storage/emulated/0/auto-click.json',
      path.resolve(homeDir, 'storage/shared/auto-click.json'),
      '/sdcard/autoclick/auto-click.json',
      '/sdcard/autoclick/autoclick.json',
      '/sdcard/autoclick/config.json',
      '/storage/emulated/0/autoclick/auto-click.json',
      '/storage/emulated/0/autoclick/config.json',
      path.resolve(homeDir, 'storage/shared/autoclick/auto-click.json'),
      path.resolve(homeDir, 'storage/shared/autoclick/config.json'),
      targetPath
    ];

    let mergedConfig = { ...defaults };
    let foundAny = false;

    for (const p of candidatePaths) {
      if (p && fs.existsSync(p)) {
        try {
          const raw = fs.readFileSync(p, 'utf-8');
          const parsed = JSON.parse(raw);
          for (const key of Object.keys(parsed) as Array<keyof BotConfig>) {
            const val = parsed[key];
            if (val !== undefined && val !== null && val !== '') {
              (mergedConfig as any)[key] = val;
            }
          }
          // Explicitly check for all GH_TOKEN alias variations in the json file
          const tokenVal =
            parsed.GH_TOKEN ||
            parsed.gh_token ||
            parsed.GITHUB_TOKEN ||
            parsed.github_token ||
            parsed.githubToken;
          if (tokenVal && typeof tokenVal === 'string' && tokenVal.trim()) {
            mergedConfig.githubToken = tokenVal.trim();
            process.env.GH_TOKEN = tokenVal.trim();
            process.env.GITHUB_TOKEN = tokenVal.trim();
          }

          // Explicitly check for all GEMINI_API_KEY alias variations in the json file
          const geminiVal =
            parsed.GEMINI_API_KEY ||
            parsed.gemini_api_key ||
            parsed.geminiApiKey ||
            parsed.geminiKey ||
            parsed.geminiToken ||
            parsed.aiKey;
          if (geminiVal && typeof geminiVal === 'string' && geminiVal.trim()) {
            mergedConfig.geminiApiKey = geminiVal.trim();
            if (!process.env.GEMINI_API_KEY) {
              process.env.GEMINI_API_KEY = geminiVal.trim();
            }
          }

          const modelVal = parsed.GEMINI_MODEL || parsed.gemini_model || parsed.geminiModel || parsed.aiModel;
          if (modelVal && typeof modelVal === 'string' && modelVal.trim()) {
            mergedConfig.geminiModel = modelVal.trim();
          }
          foundAny = true;
        } catch (err) {
          // ignore error and try next
        }
      }
    }

    // Force matchThreshold to 0.75 if it was previously saved as 0.65
    if (mergedConfig.matchThreshold === 0.65 || !mergedConfig.matchThreshold) {
      mergedConfig.matchThreshold = 0.75;
    }

    // Save final migrated/merged config to the target location so it is fully synchronized
    if (foundAny) {
      try {
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(targetPath, JSON.stringify(mergedConfig, null, 2), 'utf-8');
      } catch (err) {
        // ignore write issues
      }
    }

    return mergedConfig;
  }

  private saveConfig(): void {
    const targetPath = this.configPath || resolveConfigFilePath();
    try {
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(targetPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      ConsoleLogger.error(err, `write config ${targetPath}`);
    }
  }

  private maskWebhook(url: string): string {
    if (!url) return '';
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/');
      if (parts.length >= 4) {
        parts[parts.length - 1] = '••••••••';
      }
      return `${u.origin}${parts.join('/')}`;
    } catch {
      return '••••••••';
    }
  }
}

export const botManager = BotManager.getInstance();
