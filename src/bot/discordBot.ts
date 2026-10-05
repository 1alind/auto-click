import { Client, GatewayIntentBits, Events, Message } from 'discord.js';
import { CommandContext, CommandDefinition, CommandResult } from './types';
import { ConsoleLogger } from './consoleLogger';

export class DiscordBotClient {
  private client: Client | null = null;
  private token: string = '';
  private prefix: string = '!';
  private isConnecting = false;
  private shouldStayConnected = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private connectionPromise: Promise<{ success: boolean; message: string }> | null = null;
  private commands: Map<string, CommandDefinition> = new Map();
  private onLogCallback?: (msg: string, level: string, meta?: any) => void;

  constructor(options?: {
    token?: string;
    prefix?: string;
    onLog?: (msg: string, level: string, meta?: any) => void;
  }) {
    if (options?.token) this.token = options.token;
    if (options?.prefix) this.prefix = options.prefix;
    if (options?.onLog) this.onLogCallback = options.onLog;
  }

  public registerCommand(command: CommandDefinition): void {
    this.commands.set(command.name.toLowerCase(), command);
  }

  public getCommands(): CommandDefinition[] {
    const unique = new Map<string, CommandDefinition>();
    this.commands.forEach((cmd) => {
      unique.set(cmd.name, cmd);
    });
    return Array.from(unique.values());
  }

  public isConnected(): boolean {
    return Boolean(this.client && this.client.isReady());
  }

  public getBotUser(): { id: string; tag: string; username: string } | null {
    if (!this.client || !this.client.user) return null;
    return {
      id: this.client.user.id,
      tag: this.client.user.tag,
      username: this.client.user.username
    };
  }

  private scheduleRetryInOneMinute(): void {
    if (!this.shouldStayConnected || !this.token) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.shouldStayConnected && !this.isConnected() && !this.isConnecting) {
        this.log('🔄 Retrying Discord connection (1-minute retry)...', 'info');
        this.start(this.token).catch(() => {});
      }
    }, 60 * 1000);
  }

  private startConnectionWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (this.shouldStayConnected && this.token && !this.isConnected() && !this.isConnecting && !this.retryTimer) {
        this.log('🔄 Discord disconnected — attempting reconnect (1-minute check)...', 'info');
        this.start(this.token).catch(() => {});
      }
    }, 60 * 1000);
  }

  public async start(token?: string): Promise<{ success: boolean; message: string }> {
    if (token) this.token = token.trim();

    if (!this.token) {
      return { success: false, message: 'Discord Bot Token is required.' };
    }

    this.shouldStayConnected = true;
    this.startConnectionWatchdog();

    if (this.isConnected()) {
      return { success: true, message: 'Discord Bot is already running and connected.' };
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.isConnecting = true;

    this.connectionPromise = (async () => {
      try {
        if (this.client) {
          await this.client.destroy().catch(() => {});
        }

        this.client = new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages
          ]
        });

        this.setupEventHandlers();

        await this.client.login(this.token);
        this.isConnecting = false;
        if (this.retryTimer) {
          clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }
        this.log(`✅ Discord Bot logged in as ${this.client.user?.tag}`, 'info');

        return {
          success: true,
          message: `Logged in as ${this.client.user?.tag}`
        };
      } catch (err: any) {
        this.isConnecting = false;
        this.connectionPromise = null;
        this.log(`❌ Discord Bot login failed (${err.message}) — will retry in 1 minute...`, 'error');
        this.scheduleRetryInOneMinute();
        return {
          success: false,
          message: err.message || 'Login failed'
        };
      }
    })();

    return this.connectionPromise;
  }

  public async stop(): Promise<{ success: boolean; message: string }> {
    this.shouldStayConnected = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.connectionPromise = null;
    if (this.client) {
      try {
        await this.client.destroy();
        this.client = null;
        ConsoleLogger.stopped();
        this.log('🛑 Discord Bot disconnected gracefully.', 'info');
        return { success: true, message: 'Discord bot disconnected.' };
      } catch (err: any) {
        ConsoleLogger.error(err, 'discord stop');
        return { success: false, message: err.message };
      }
    }
    return { success: true, message: 'Bot was not connected.' };
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.on(Events.ClientReady, async () => {
      this.log(`🤖 Discord Client is ready! Monitoring commands with prefix "${this.prefix}"`, 'info');
      try {
        const { botManager } = await import('./botManager');
        const webhook = botManager.getWebhookService();
        if (webhook.isConfigured()) {
          await webhook.send({ content: 'ready' }).catch(() => {});
        }
        const { MacroManager } = await import('./macroManager');
        await MacroManager.resumeStartIfNeeded();
      } catch {
        // ignore ready notification error
      }
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages
      if (message.author.bot) return;

      // Only receive commands from channel 1553844985776836638
      if (message.channelId !== '1553844985776836638') return;

      const raw = message.content.trim();
      if (!raw) return;

      // Strip optional prefix '!', configured prefix, or mentions
      let clean = raw;
      if (this.prefix && clean.startsWith(this.prefix)) {
        clean = clean.slice(this.prefix.length).trim();
      } else if (clean.startsWith('!')) {
        clean = clean.slice(1).trim();
      } else if (this.client?.user && message.mentions.has(this.client.user)) {
        clean = clean.replace(/<@!?[0-9]+>/g, '').trim();
      }

      const parts = clean.split(/\s+/);
      const commandKey = parts[0]?.toLowerCase() || '';
      const args = parts.slice(1);

      if (!commandKey) return;

      const command = this.commands.get(commandKey);
      if (!command) return;

      this.log(`📩 Command received: "${commandKey}" from ${message.author.tag} in #${('name' in message.channel ? (message.channel as any).name : 'DM')}`, 'command');

      const ctx: CommandContext = {
        commandName: commandKey,
        args,
        author: {
          id: message.author.id,
          tag: message.author.tag,
          username: message.author.username
        },
        channelId: message.channelId,
        discordMessage: message,
        reply: async (replyText: string) => {
          try {
            const { botManager } = await import('./botManager');
            const webhook = botManager.getWebhookService();
            if (webhook.isConfigured()) {
              await webhook.send({
                content: replyText
              });
            } else {
              this.log(`⚠️ Discord Webhook not configured; message dropped (bot never sends directly): "${replyText}"`, 'warn');
            }
          } catch (e: any) {
            this.log(`Failed to send webhook message: ${e.message}`, 'warn');
          }
        },
        log: (msg: string, level = 'info', meta?: any) => {
          this.log(msg, level, meta);
        }
      };

      try {
        const { MacroManager } = await import('./macroManager');
        if (MacroManager.isFindRunning()) {
          this.log(`⏳ Command "${commandKey}" queued — waiting for "find" to finish...`, 'info');
          await MacroManager.waitForFind();
        }
        await command.execute(ctx);
      } catch (err: any) {
        ConsoleLogger.error(err, `command ${commandKey}`);
        this.log(`Error executing command ${commandKey}: ${err.message}`, 'error', err);
        try {
          const { botManager } = await import('./botManager');
          const webhook = botManager.getWebhookService();
          if (webhook.isConfigured()) {
            await webhook.send({
              content: `error: ${err.message}`
            });
          }
        } catch {
          // ignore
        }
      }
    });

    this.client.on(Events.Error, (err) => {
      ConsoleLogger.error(err, 'discord client');
      this.log(`Discord client runtime error: ${err.message}`, 'error');
    });
  }

  public async executeCommandByName(
    name: string,
    args: string[] = [],
    customContext?: Partial<CommandContext>
  ): Promise<CommandResult> {
    const cmd = this.commands.get(name.toLowerCase());
    if (!cmd) {
      return { success: false, message: `Command "${name}" not found.` };
    }

    const ctx: CommandContext = {
      commandName: name,
      args,
      log: (msg, level = 'info', meta) => this.log(msg, level, meta),
      ...customContext
    };

    return await cmd.execute(ctx);
  }

  private log(message: string, level: string = 'info', meta?: any): void {
    if (this.onLogCallback) {
      this.onLogCallback(message, level, meta);
    }
  }
}
