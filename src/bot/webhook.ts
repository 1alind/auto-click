import fs from 'fs';
import path from 'path';
import { StoragePaths } from './storagePaths';
import { createControlButtonsJson } from './discordButtons';

export interface WebhookSendOptions {
  content?: string;
  username?: string;
  avatarUrl?: string;
  embeds?: any[];
  components?: any[];
  fileBuffer?: Buffer;
  fileName?: string;
  rawContent?: boolean;
  forceNewMessage?: boolean;
}

export class WebhookService {
  private webhookUrl: string = '';
  private dashboardMessageId: string | null = null;
  private lastMediaMessageId: string | null = null;
  private mediaDeleteTimer: NodeJS.Timeout | null = null;

  constructor(webhookUrl?: string) {
    if (webhookUrl) {
      this.webhookUrl = webhookUrl;
    }
  }

  public setWebhookUrl(url: string): void {
    this.webhookUrl = url;
  }

  public getWebhookUrl(): string {
    return this.webhookUrl;
  }

  public isConfigured(): boolean {
    return Boolean(this.webhookUrl && this.webhookUrl.startsWith('https://discord.com/api/webhooks/'));
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

  /**
   * Deletes a message created by the webhook using DELETE /messages/{messageId}.
   */
  public async deleteMessage(messageId: string): Promise<boolean> {
    if (!this.webhookUrl || !messageId) return false;
    const delUrl = this.buildEditUrl(messageId);
    try {
      const res = await fetch(delUrl, { method: 'DELETE' });
      return res.status === 204 || res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Clears any active temporary screenshot message (Option 3: auto-cleanup).
   */
  public async clearTemporaryMedia(): Promise<void> {
    if (this.mediaDeleteTimer) {
      clearTimeout(this.mediaDeleteTimer);
      this.mediaDeleteTimer = null;
    }
    if (this.lastMediaMessageId) {
      const id = this.lastMediaMessageId;
      this.lastMediaMessageId = null;
      await this.deleteMessage(id).catch(() => {});
    }
  }

  private formatContent(raw?: string): string {
    if (!raw) return '';
    return raw
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        return trimmed.startsWith('-#') ? trimmed : `-# ${trimmed}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  private buildWaitUrl(): string {
    try {
      const u = new URL(this.webhookUrl.trim());
      u.searchParams.set('wait', 'true');
      return u.toString();
    } catch {
      return this.webhookUrl.includes('?') ? `${this.webhookUrl}&wait=true` : `${this.webhookUrl}?wait=true`;
    }
  }

  private buildEditUrl(messageId: string): string {
    try {
      const u = new URL(this.webhookUrl.trim());
      u.searchParams.delete('wait');
      u.pathname = `${u.pathname.replace(/\/+$/, '')}/messages/${messageId}`;
      return u.toString();
    } catch {
      const base = this.webhookUrl.split('?')[0].replace(/\/+$/, '');
      return `${base}/messages/${messageId}`;
    }
  }

  /**
   * Sends or updates a Discord message.
   * - If text-only (no fileBuffer): Always edits the single dashboard message in place with buttons attached!
   * - If fileBuffer (Screenshot/Image): Sends the image and auto-deletes it after 90 seconds (Option 3).
   */
  public async send(
    options: WebhookSendOptions
  ): Promise<{ success: boolean; status?: number; messageId?: string; error?: string }> {
    if (!this.webhookUrl) {
      return { success: false, error: 'Discord Webhook URL is not configured.' };
    }

    // Handle Screenshot/Image Attachment (Option 3)
    if (options.fileBuffer) {
      // Clear previous temporary media first so there's never more than 1 image
      await this.clearTemporaryMedia().catch(() => {});

      const formattedContent = options.rawContent ? (options.content || '') : this.formatContent(options.content);
      const targetUrl = this.buildWaitUrl();

      try {
        const formData = new FormData();
        const fileName = options.fileName || `screenshot_${Date.now()}.png`;
        const blob = new Blob([new Uint8Array(options.fileBuffer)], { type: 'image/png' });
        formData.append('files[0]', blob, fileName);

        const payloadJson: any = {
          username: options.username || 'Android ADB Automation Bot',
          content: formattedContent,
          allowed_mentions: { parse: [] }
        };

        if (options.avatarUrl) {
          payloadJson.avatar_url = options.avatarUrl;
        }

        formData.append('payload_json', JSON.stringify(payloadJson));

        const response = await fetch(targetUrl, {
          method: 'POST',
          body: formData
        });

        if (!response.ok) {
          const errText = await response.text();
          return { success: false, status: response.status, error: `Webhook HTTP ${response.status}: ${errText}` };
        }

        const data: any = await response.json().catch(() => null);
        const msgId = data?.id;

        if (msgId) {
          this.lastMediaMessageId = msgId;
          // Option 3: Auto-delete the temporary screenshot after 90 seconds so channel stays clean
          this.mediaDeleteTimer = setTimeout(() => {
            void this.clearTemporaryMedia();
          }, 90 * 1000);
        }

        return { success: true, status: response.status, messageId: msgId };
      } catch (err: any) {
        return { success: false, error: err.message || 'Network error sending image attachment' };
      }
    }

    // Text Message -> Single Dashboard Message with Buttons attached!
    // Dynamically ensure control buttons are always attached
    if (!options.components) {
      let isRunning = false;
      try {
        const { MacroManager } = await import('./macroManager');
        isRunning = MacroManager.isStartRunning();
      } catch {}
      options.components = createControlButtonsJson(isRunning);
    }

    const currentDashboardId = this.getDashboardMessageId();

    // If we have an existing dashboard message ID and not forced new, edit it!
    if (currentDashboardId && !options.forceNewMessage) {
      const editResult = await this.edit(currentDashboardId, options);
      if (editResult.success) {
        return { success: true, status: editResult.status, messageId: currentDashboardId };
      }

      // If edit failed with 404 (Unknown Message), user deleted it: clear and recreate
      if (editResult.status === 404 || (editResult.error && editResult.error.includes('10008'))) {
        this.saveDashboardMessageId(null);
      } else {
        // Transient error or other issue
        return { success: false, status: editResult.status, error: editResult.error };
      }
    }

    // Create the single persistent dashboard message
    const formattedContent = options.rawContent ? (options.content || '') : this.formatContent(options.content);
    const targetUrl = this.buildWaitUrl();

    try {
      const payload: any = {
        username: options.username || 'Android ADB Automation Bot',
        content: formattedContent,
        allowed_mentions: { parse: [] }
      };

      if (options.avatarUrl) payload.avatar_url = options.avatarUrl;
      if (options.components) payload.components = options.components;

      let response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok && options.components) {
        const errText = await response.text();
        if (errText.toLowerCase().includes('component')) {
          // Webhook not owned by application; retry without components
          delete payload.components;
          response = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
        } else {
          return { success: false, status: response.status, error: `Webhook HTTP ${response.status}: ${errText}` };
        }
      }

      if (!response.ok) {
        const errText = await response.text();
        return { success: false, status: response.status, error: `Webhook HTTP ${response.status}: ${errText}` };
      }

      const data: any = await response.json().catch(() => null);
      if (data?.id) {
        this.saveDashboardMessageId(data.id);
      }

      return { success: true, status: response.status, messageId: data?.id };
    } catch (err: any) {
      return { success: false, error: err.message || 'Network error sending webhook' };
    }
  }

  /**
   * Updates an existing Discord webhook message by its message ID using PATCH /webhooks/{id}/{token}/messages/{messageId}.
   */
  public async edit(
    messageId: string,
    options: WebhookSendOptions
  ): Promise<{ success: boolean; status?: number; error?: string }> {
    if (!this.webhookUrl || !messageId) {
      return { success: false, error: 'Webhook URL or messageId is missing.' };
    }

    // Ensure buttons are attached if not specified
    if (!options.components && !options.fileBuffer) {
      let isRunning = false;
      try {
        const { MacroManager } = await import('./macroManager');
        isRunning = MacroManager.isStartRunning();
      } catch {}
      options.components = createControlButtonsJson(isRunning);
    }

    const formattedContent = options.rawContent ? (options.content || '') : this.formatContent(options.content);
    const editUrl = this.buildEditUrl(messageId);

    try {
      if (options.fileBuffer) {
        const formData = new FormData();
        const fileName = options.fileName || `cropped_${Date.now()}.png`;
        const blob = new Blob([new Uint8Array(options.fileBuffer)], { type: 'image/png' });
        formData.append('files[0]', blob, fileName);

        const payloadJson: any = {
          content: formattedContent,
          allowed_mentions: { parse: [] }
        };
        if (options.components) payloadJson.components = options.components;

        formData.append('payload_json', JSON.stringify(payloadJson));

        let response = await fetch(editUrl, {
          method: 'PATCH',
          body: formData
        });

        if (!response.ok && options.components) {
          const errText = await response.text();
          if (errText.toLowerCase().includes('component')) {
            const fallbackForm = new FormData();
            const fallbackBlob = new Blob([new Uint8Array(options.fileBuffer)], { type: 'image/png' });
            fallbackForm.append('files[0]', fallbackBlob, fileName);
            delete payloadJson.components;
            fallbackForm.append('payload_json', JSON.stringify(payloadJson));
            response = await fetch(editUrl, {
              method: 'PATCH',
              body: fallbackForm
            });
          } else {
            return { success: false, status: response.status, error: `Webhook PATCH HTTP ${response.status}: ${errText}` };
          }
        }

        if (!response.ok) {
          const errText = await response.text();
          return { success: false, status: response.status, error: `Webhook PATCH HTTP ${response.status}: ${errText}` };
        }

        return { success: true, status: response.status };
      } else {
        const payload: any = {
          content: formattedContent,
          allowed_mentions: { parse: [] }
        };
        if (options.components) payload.components = options.components;

        let response = await fetch(editUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!response.ok && options.components) {
          const errText = await response.text();
          if (errText.toLowerCase().includes('component')) {
            delete payload.components;
            response = await fetch(editUrl, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
          } else {
            return { success: false, status: response.status, error: `Webhook PATCH HTTP ${response.status}: ${errText}` };
          }
        }

        if (!response.ok) {
          const errText = await response.text();
          return { success: false, status: response.status, error: `Webhook PATCH HTTP ${response.status}: ${errText}` };
        }

        return { success: true, status: response.status };
      }
    } catch (err: any) {
      return { success: false, error: err.message || 'Network error editing webhook message' };
    }
  }
}
