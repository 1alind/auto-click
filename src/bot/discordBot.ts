import { Client, GatewayIntentBits, Partials, Events, Message, AttachmentBuilder } from 'discord.js';
import { CommandContext, CommandDefinition, CommandResult } from './types';
import { ConsoleLogger } from './consoleLogger';
import { StoragePaths } from './storagePaths';
import { createControlButtons } from './discordButtons';
import fs from 'fs';
import path from 'path';

export class DiscordBotClient {
  private client: Client | null = null;
  private token: string = '';
  private prefix: string = '!';
  private targetChannelId: string | null = null;
  private dashboardMessageId: string | null = null;
  private lastMediaMessageId: string | null = null;
  private mediaDeleteTimer: NodeJS.Timeout | null = null;
  private dismissableErrorMsgIds: Set<string> = new Set();
  private awaitingChannelId = false;
  private isClean = false;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private isPurging = false;
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
    this.loadDismissableErrorMessages();
    this.targetChannelId = this.loadChannelId();
    this.isClean = this.loadChannelStatus();
  }

  public loadChannelId(): string | null {
    const candidatePaths = [
      StoragePaths.getChannelIdPath(),
      path.join(StoragePaths.getBaseDir(), 'channel-id.json'),
      '/sdcard/autoclick/config/channel-id.json',
      '/sdcard/autoclick/channel-id.json'
    ];
    for (const p of candidatePaths) {
      try {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf-8').trim();
          try {
            const parsed = JSON.parse(raw);
            const id = parsed?.channelId || parsed?.channel_id || parsed?.id || (typeof parsed === 'string' ? parsed : null);
            if (id && typeof id === 'string') return id.trim();
          } catch {
            if (/^\d{15,22}$/.test(raw)) return raw;
          }
        }
      } catch {}
    }
    return null;
  }

  public getMainChannelId(): string | null {
    return this.loadChannelId() || this.targetChannelId;
  }

  public saveChannelId(id: string): void {
    this.targetChannelId = id;
    this.isClean = false; // Reset clean status when channel ID changes
    try {
      const p = StoragePaths.getChannelIdPath();
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ channelId: id }), 'utf-8');
    } catch {}
  }

  private loadChannelStatus(): boolean {
    try {
      const p = StoragePaths.getChannelStatusPath();
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const parsed = JSON.parse(raw);
        return Boolean(parsed?.isClean);
      }
    } catch {}
    return false;
  }

  public saveChannelStatus(isClean: boolean): void {
    this.isClean = isClean;
    try {
      const p = StoragePaths.getChannelStatusPath();
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ isClean }), 'utf-8');
    } catch {}
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

  public getClient(): Client | null {
    return this.client;
  }

  public getTargetChannelId(): string | null {
    return this.targetChannelId;
  }

  public setTargetChannelId(id: string): void {
    if (id) this.targetChannelId = id.trim();
  }

  public getDashboardMessageId(): string | null {
    if (!this.dashboardMessageId) {
      this.dashboardMessageId = this.loadDashboardMessageId();
    }
    return this.dashboardMessageId;
  }

  private loadDashboardMessageId(): string | null {
    try {
      const p = StoragePaths.getDashboardMessagePath();
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed?.messageId) return parsed.messageId;
      }
    } catch {}
    return null;
  }

  public saveDashboardMessageId(id: string | null): void {
    this.dashboardMessageId = id;
    try {
      const p = StoragePaths.getDashboardMessagePath();
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        p,
        JSON.stringify({ messageId: id, updatedAt: new Date().toISOString() }, null, 2),
        'utf-8'
      );
    } catch {}
  }

  private getDismissableErrorsPath(): string {
    return path.join(StoragePaths.getConfigDir(), 'dismissable-errors.json');
  }

  private loadDismissableErrorMessages(): void {
    try {
      const p = this.getDismissableErrorsPath();
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.dismissableErrorMsgIds = new Set(list);
        }
      }
    } catch {}
  }

  private saveDismissableErrorMessages(): void {
    try {
      const p = this.getDismissableErrorsPath();
      fs.writeFileSync(p, JSON.stringify(Array.from(this.dismissableErrorMsgIds)), 'utf-8');
    } catch {}
  }

  public addDismissableErrorMessage(messageId: string): void {
    this.dismissableErrorMsgIds.add(messageId);
    this.saveDismissableErrorMessages();
  }

  public isDismissableErrorMessage(messageId: string): boolean {
    return this.dismissableErrorMsgIds.has(messageId);
  }

  public removeDismissableErrorMessage(messageId: string): void {
    this.dismissableErrorMsgIds.delete(messageId);
    this.saveDismissableErrorMessages();
  }

  /**
   * Sends an error message (like buttons not found or execution failure) as a separate new message.
   * Registers the message ID so that when ANY reaction is added to it by a user, the bot automatically deletes it.
   */
  public async sendErrorMessage(options: {
    content: string;
    fileBuffer?: Buffer;
    fileName?: string;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.client || !this.client.isReady()) {
      return { success: false, error: 'Discord Bot is not connected' };
    }

    try {
      const textChannel = await this.resolveTargetChannel();
      if (!textChannel) {
        return { success: false, error: 'Target channel not accessible' };
      }

      const files: AttachmentBuilder[] = [];
      if (options.fileBuffer) {
        const name = options.fileName || `error_${Date.now()}.png`;
        files.push(new AttachmentBuilder(options.fileBuffer, { name }));
      }

      // Ensure each line starts with -#
      const body = this.formatContent(options.content);

      const sentMsg = await textChannel.send({
        content: body,
        files: files.length > 0 ? files : undefined
      });

      if (sentMsg?.id) {
        this.addDismissableErrorMessage(sentMsg.id);
        return { success: true, messageId: sentMsg.id };
      }

      return { success: true };
    } catch (err: any) {
      this.log(`Error sending separate error message: ${err.message}`, 'error');
      return { success: false, error: err.message };
    }
  }

  public formatContent(raw?: string): string {
    if (!raw) return '';
    return raw
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        // Never send reaction hint line
        if (/react with any emoji/i.test(trimmed) || /remove this message/i.test(trimmed)) return '';
        // If it's a URL or markdown link [text](url), keep it clean without -# so Discord renders it as a clickable link
        if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('[')) return trimmed;
        // If it's already a component/button-only line (starting with <) or already formatted, leave it, else prepend -#
        return trimmed.startsWith('-#') || trimmed.startsWith('<') ? trimmed : `-# ${trimmed}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  public async clearTemporaryMedia(): Promise<void> {
    if (this.mediaDeleteTimer) {
      clearTimeout(this.mediaDeleteTimer);
      this.mediaDeleteTimer = null;
    }
    if (this.lastMediaMessageId && this.client && this.client.isReady()) {
      const id = this.lastMediaMessageId;
      this.lastMediaMessageId = null;
      try {
        const channel = await this.client.channels.fetch(this.targetChannelId!).catch(() => null);
        if (channel && channel.isTextBased()) {
          const msg = await (channel as any).messages.fetch(id).catch(() => null);
          if (msg) await msg.delete().catch(() => {});
        }
      } catch {}
    }
  }

  public async purgeChannel(): Promise<{ totalDeleted: number; error?: string }> {
    if (this.isPurging) {
      return { totalDeleted: 0, error: 'Purge already in progress' };
    }
    this.isPurging = true;

    try {
      const textChannel = await this.resolveTargetChannel();
      if (!textChannel) {
        this.log('⚠️ Target channel from channel-id.json not found or not accessible for cleanup', 'warn');
        return { totalDeleted: 0, error: 'Main channel from channel-id.json not found' };
      }

      const dashboardId = this.getDashboardMessageId();

      // Fetch messages from the main channel
      const fetched = await textChannel.messages.fetch({ limit: 100 }).catch((e: any) => {
        this.log(`⚠️ Failed to fetch messages for cleanup: ${e.message}`, 'warn');
        return null;
      });

      if (!fetched) {
        return { totalDeleted: 0, error: 'Failed to fetch messages' };
      }

      // Filter out the persistent dashboard message
      const toDelete = fetched.filter((m: any) => m.id !== dashboardId);

      if (toDelete.size === 0) {
        this.saveChannelStatus(true);
        if (this.cleanupInterval) {
          clearInterval(this.cleanupInterval);
          this.cleanupInterval = null;
        }
        this.log('✅ Main channel is already clean (only dashboard remains).', 'info');
        return { totalDeleted: 0 };
      }

      this.log(`🧹 Found ${toDelete.size} message(s) to remove in main channel #${textChannel.name || ''} (${textChannel.id})`, 'info');

      let tempNotice: any = null;

      let deletedCount = 0;
      for (const msg of toDelete.values()) {
        if (tempNotice && msg.id === tempNotice.id) continue;
        if (msg.id === dashboardId) continue;

        try {
          await msg.delete();
          deletedCount++;
        } catch (delErr: any) {
          this.log(`⚠️ Could not delete message ${msg.id}: ${delErr.message}`, 'warn');
        }

        // 5-second delay between deletions to avoid rate limits
        await new Promise((r) => setTimeout(r, 5000));
      }

      // Check if channel is now clean
      const remaining = await textChannel.messages.fetch({ limit: 50 }).catch(() => null);
      const remainingOther = remaining
        ? remaining.filter((m: any) => m.id !== dashboardId && (!tempNotice || m.id !== tempNotice.id))
        : null;

      if (!remainingOther || remainingOther.size === 0) {
        this.saveChannelStatus(true);
        if (this.cleanupInterval) {
          clearInterval(this.cleanupInterval);
          this.cleanupInterval = null;
        }
        this.log('✅ Main channel is now clean. Saved isClean: true.', 'info');
      }

      // Update and auto-delete the temporary notice after 4 seconds
      if (tempNotice) {
        try {
          await tempNotice.edit(`-# ✅ Cleanup complete: ${deletedCount} message(s) removed.`);
          setTimeout(async () => {
            await tempNotice.delete().catch(() => {});
          }, 4000);
        } catch {
          await tempNotice.delete().catch(() => {});
        }
      }

      return { totalDeleted: deletedCount };
    } finally {
      this.isPurging = false;
    }
  }

  public startAutoCleanupTask(runImmediately = true): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (runImmediately && !this.isClean) {
      void this.purgeChannel();
    }

    // Periodically check every 20 minutes if not marked clean
    this.cleanupInterval = setInterval(async () => {
      if (this.isClean) {
        if (this.cleanupInterval) {
          clearInterval(this.cleanupInterval);
          this.cleanupInterval = null;
        }
        return;
      }
      await this.purgeChannel();
    }, 20 * 60 * 1000);
  }

  public async resolveTargetChannel(): Promise<any> {
    if (!this.client || !this.client.isReady()) return null;

    const channelId = this.getMainChannelId();
    if (channelId) {
      const ch = await this.client.channels.fetch(channelId).catch(() => null);
      if (ch && ch.isTextBased()) return ch;
    }

    return null;
  }

  /**
   * Updates the single persistent dashboard message in the channel directly using the Discord bot.
   * Attaches control buttons and keeps button states synchronized with bot run state.
   */
  public async updateDashboard(options: {
    content?: string;
    rawContent?: boolean;
    components?: any[];
    fileBuffer?: Buffer;
    fileName?: string;
    forceNewMessage?: boolean;
    isRunning?: boolean;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.client || !this.client.isReady()) {
      return { success: false, error: 'Discord Bot is not connected' };
    }

    try {
      const textChannel = await this.resolveTargetChannel();
      if (!textChannel) {
        this.log(`⚠️ Target Discord channel ${this.targetChannelId} not found or not accessible`, 'warn');
        return { success: false, error: 'Target channel not accessible' };
      }

      // Handle Screenshot / Image Attachment (Option 3: auto-cleans after 90s, keeps dashboard clean)
      if (options.fileBuffer) {
        await this.clearTemporaryMedia().catch(() => {});
        const fileName = options.fileName || `screenshot_${Date.now()}.png`;
        const attachment = new AttachmentBuilder(options.fileBuffer, { name: fileName });
        const formattedContent = this.formatContent(options.content || '');

        const sent = await textChannel.send({
          content: formattedContent || undefined,
          files: [attachment]
        });

        if (sent?.id) {
          this.lastMediaMessageId = sent.id;
          if (this.mediaDeleteTimer) clearTimeout(this.mediaDeleteTimer);
          this.mediaDeleteTimer = setTimeout(async () => {
            await this.clearTemporaryMedia().catch(() => {});
          }, 90 * 1000);
        }

        // Also update the persistent single dashboard message with the latest capture alert & buttons
        void this.updateDashboard({
          content: `-# 📸 screenshot captured (${fileName})\n-# (screenshot clears automatically to keep channel clean)`,
          rawContent: true,
          isRunning: options.isRunning
        }).catch(() => {});

        return { success: true, messageId: sent?.id };
      }

      // Handle Text / Live Status / Dashboard with Buttons
      let isRunning = options.isRunning;
      if (isRunning === undefined) {
        try {
          const { MacroManager } = await import('./macroManager');
          isRunning = Boolean(MacroManager.getRunningMacro());
        } catch {
          isRunning = false;
        }
      }

      let formattedContent: string | undefined;
      if (options.content !== undefined) {
        formattedContent = this.formatContent(options.content);
      }

      const row = createControlButtons(isRunning);
      const defaultContent = this.formatContent(isRunning ? 'airstrike working' : '🟢 bot online');
      const contentToSend = formattedContent !== undefined ? formattedContent : defaultContent;

      let currentDashboardId = this.getDashboardMessageId();
      let existingMsg: any = null;

      if (currentDashboardId && !options.forceNewMessage) {
        existingMsg = await textChannel.messages.fetch(currentDashboardId).catch(() => null);
        if (!existingMsg) {
          // If messageId was deleted or not found, clear it so a clean new dashboard message is created
          this.saveDashboardMessageId(null);
        }
      }

      if (existingMsg) {
        try {
          const edited = await existingMsg.edit({
            content: contentToSend,
            components: [row]
          });
          this.saveDashboardMessageId(edited.id);
          return { success: true, messageId: edited.id };
        } catch (editErr: any) {
          this.log(`Existing dashboard message (${existingMsg.id}) not editable (${editErr.message}), recreating`, 'info');
          await existingMsg.delete().catch(() => {});
          this.saveDashboardMessageId(null);
        }
      }

      const newMsg = await textChannel.send({
        content: contentToSend,
        components: [row]
      });
      this.saveDashboardMessageId(newMsg.id);
      return { success: true, messageId: newMsg.id };
    } catch (err: any) {
      this.log(`Error updating dashboard message: ${err.message}`, 'error', err);
      return { success: false, error: err.message };
    }
  }

  public async sendToChannel(
    channelId: string,
    options: { content?: string; components?: any[]; files?: any[] }
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.client || !this.client.isReady()) {
      return { success: false, error: 'Discord Bot is not connected' };
    }
    try {
      const channel = await this.client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        return { success: false, error: 'Channel not found or not text-based' };
      }
      
      const formattedOptions = { ...options };
      if (options.content) {
        formattedOptions.content = this.formatContent(options.content);
      }
      
      const sent = await (channel as any).send(formattedOptions);
      return { success: true, messageId: sent?.id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
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
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.DirectMessageReactions,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages
          ],
          partials: [Partials.Message, Partials.Channel, Partials.Reaction]
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
    try {
      const { MacroManager } = await import('./macroManager');
      const { stopHold, stopFarm } = await import('./commands/index');
      const { stopSub } = await import('./commands/sub');
      MacroManager.stopAll();
      stopHold();
      stopFarm();
      stopSub();
      const { botManager } = await import('./botManager');
      await botManager.getAdbController().stopAllTaps();
    } catch {}

    this.connectionPromise = null;
    if (this.client) {
      try {
        await this.client.destroy();
        this.client = null;
        ConsoleLogger.stopped();
        this.log('🛑 Discord Bot disconnected gracefully and all taps disabled.', 'info');
        return { success: true, message: 'Discord bot disconnected and all taps disabled.' };
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
      this.log(`🤖 Discord Client is ready!`, 'info');
      
      const mainChannelId = this.getMainChannelId();
      if (!mainChannelId) {
        this.awaitingChannelId = true;
        this.log('⚠️ Target channel not configured. Please reply with the Channel ID to configure.', 'warn');
        for (const guild of this.client!.guilds.cache.values()) {
          const textCh = guild.channels.cache.find(
            (c) => c.isTextBased() && (c as any).permissionsFor?.(this.client!.user!)?.has(['ViewChannel', 'SendMessages'])
          );
          if (textCh) {
            await (textCh as any).send('🤖 **Bot initialized.** Please reply with the `Channel ID` you want me to use for the dashboard.').catch(() => {});
          }
        }
      } else {
        this.targetChannelId = mainChannelId;
        await this.resolveTargetChannel().catch(() => {});
        this.log(`Monitoring main channel ${mainChannelId} from channel-id.json with prefix "${this.prefix}"`, 'info');
        try {
          const { MacroManager } = await import('./macroManager');
          const isRunning = Boolean(MacroManager.getRunningMacro());
          await this.updateDashboard({
            content: isRunning ? '-# airstrike working' : '-# 🟢 bot online',
            isRunning
          }).catch(() => {});
          await MacroManager.resumeStartIfNeeded();
          this.startAutoCleanupTask(true);
        } catch {
          // ignore ready notification error
        }
      }
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages
      if (message.author.bot) return;

      if (this.awaitingChannelId) {
        const channelId = message.content.trim();
        if (/^\d{15,20}$/.test(channelId)) {
          this.saveChannelId(channelId);
          this.awaitingChannelId = false;
          message.reply(`✅ Target channel set to \`${channelId}\`.`).catch(() => {});
          this.log(`Channel configured: ${channelId}`, 'info');
          // Restart to properly initialize dashboard in new channel
          setTimeout(() => process.exit(0), 1000);
        } else {
          message.reply('⚠️ Invalid Channel ID format. Please reply with a valid 15-20 digit Channel ID.').catch(() => {});
        }
        return;
      }

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
            // Always send a separate new message for command replies instead of updating the main dashboard
            const sentReply = await this.sendErrorMessage({ content: replyText });
            if (sentReply.messageId) {
              // Auto-delete the command reply message after 2 minutes (120,000ms)
              setTimeout(async () => {
                try {
                  if (this.client && this.client.isReady()) {
                    const channel = await this.client.channels.fetch(this.targetChannelId!).catch(() => null);
                    if (channel && channel.isTextBased()) {
                      const m = await (channel as any).messages.fetch(sentReply.messageId).catch(() => null);
                      if (m) await m.delete().catch(() => {});
                    }
                  }
                } catch {}
              }, 120 * 1000);
            }
          } catch (e: any) {
            this.log(`Failed to send command reply message: ${e.message}`, 'warn');
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
        await message.delete().catch(() => {});
      } catch (err: any) {
        ConsoleLogger.error(err, `command ${commandKey}`);
        this.log(`Error executing command ${commandKey}: ${err.message}`, 'error', err);
        await message.delete().catch(() => {});
        try {
          await this.sendErrorMessage({ content: `❌ error executing ${commandKey}: ${err.message}` });
        } catch {
          // ignore
        }
      }
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) return;

      const customId = interaction.customId;
      this.log(`🔘 Button clicked: "${customId}" by ${interaction.user.tag}`, 'info');

      // Acknowledge interaction quickly so Discord doesn't timeout
      await interaction.deferUpdate().catch(() => {});

      // Clear any temporary screenshot so the channel cleanly returns to 1 message
      await this.clearTemporaryMedia().catch(() => {});

      let commandName = '';
      let args: string[] = [];

      switch (customId) {
        case 'btn_stop':
          commandName = 'stop';
          break;
        case 'btn_start':
          commandName = 'start';
          break;
        case 'btn_fixac':
          commandName = 'fixac';
          break;
        case 'btn_status':
          commandName = 'status';
          break;
        case 'btn_screenshot':
          commandName = 'screenshot';
          break;
        case 'btn_ping':
          commandName = 'ping';
          break;
        default:
          if (customId.startsWith('cmd_')) {
            const raw = customId.slice(4);
            const parts = raw.split('_');
            commandName = parts[0];
            args = parts.slice(1);
          }
          break;
      }

      if (!commandName) return;

      const command = this.commands.get(commandName.toLowerCase());
      if (!command) {
        this.log(`Command for button "${customId}" not found`, 'warn');
        await this.sendErrorMessage({ content: `❌ button command "${customId}" not found` }).catch(() => {});
        return;
      }

      const ctx: CommandContext = {
        commandName,
        args,
        author: {
          id: interaction.user.id,
          tag: interaction.user.tag,
          username: interaction.user.username
        },
        channelId: interaction.channelId,
        reply: async (replyText: string) => {
          try {
            if (
              replyText.startsWith('❌') ||
              replyText.toLowerCase().includes('not found') ||
              replyText.toLowerCase().startsWith('error:') ||
              replyText.toLowerCase().startsWith('error ')
            ) {
              await this.sendErrorMessage({ content: replyText });
            } else {
              await this.updateDashboard({ content: replyText });
            }
          } catch (e: any) {
            this.log(`Failed to reply to button action: ${e.message}`, 'warn');
          }
        },
        log: (msg: string, level = 'info', meta?: any) => {
          this.log(msg, level, meta);
        }
      };

      try {
        const { MacroManager } = await import('./macroManager');
        if (MacroManager.isFindRunning()) {
          this.log(`⏳ Button "${commandName}" queued — waiting for "find" to finish...`, 'info');
          await MacroManager.waitForFind();
        }
        await command.execute(ctx);
      } catch (err: any) {
        ConsoleLogger.error(err, `button ${commandName}`);
        this.log(`Error executing button ${commandName}: ${err.message}`, 'error', err);
        try {
          await this.sendErrorMessage({ content: `❌ error executing ${commandName}: ${err.message}` });
        } catch {}
      }
    });

    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      // Ignore bot reactions
      if (user.bot) return;

      try {
        if (reaction.partial) {
          await reaction.fetch().catch(() => {});
        }
        if (reaction.message.partial) {
          await reaction.message.fetch().catch(() => {});
        }

        const msg = reaction.message;
        const msgId = msg.id;
        
        this.log(`Reaction detected on message ${msgId}. Author ID: ${msg.author?.id}, Bot ID: ${this.client?.user?.id}`, 'info');

        // If any message sent by the bot receives a reaction, delete it (EXCEPT the main dashboard message)
        if (msg.author?.id === this.client?.user?.id) {
          const dashboardId = this.getDashboardMessageId();
          if (msgId === dashboardId) {
            // Never delete the main dashboard message even if reacted to
            return;
          }

          this.removeDismissableErrorMessage(msgId);
          this.log(`🗑️ User ${user.tag} reacted to bot message (${msgId}). Removing message...`, 'info');
          await msg.delete().catch(() => {});
        }
      } catch (err: any) {
        this.log(`Failed to delete message on reaction: ${err.message}`, 'warn');
        try {
          await this.sendErrorMessage({ content: `❌ reaction error: ${err.message}` });
        } catch {}
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
