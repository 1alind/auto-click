export interface WebhookSendOptions {
  content?: string;
  username?: string;
  avatarUrl?: string;
  embeds?: any[];
  fileBuffer?: Buffer;
  fileName?: string;
}

export class WebhookService {
  private webhookUrl: string = '';

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
   * Sends a payload with optional image file attachment to the configured Discord webhook.
   * Uses ?wait=true so Discord returns the created message ID for subsequent edits.
   */
  public async send(
    options: WebhookSendOptions
  ): Promise<{ success: boolean; status?: number; messageId?: string; error?: string }> {
    if (!this.webhookUrl) {
      return { success: false, error: 'Discord Webhook URL is not configured.' };
    }

    const formattedContent = this.formatContent(options.content);
    const targetUrl = this.buildWaitUrl();

    try {
      if (options.fileBuffer) {
        const formData = new FormData();
        const fileName = options.fileName || `cropped_${Date.now()}.png`;
        const blob = new Blob([options.fileBuffer], { type: 'image/png' });
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
        return { success: true, status: response.status, messageId: data?.id };
      } else {
        const payload: any = {
          username: options.username || 'Android ADB Automation Bot',
          content: formattedContent,
          allowed_mentions: { parse: [] }
        };

        if (options.avatarUrl) payload.avatar_url = options.avatarUrl;

        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errText = await response.text();
          return { success: false, status: response.status, error: `Webhook HTTP ${response.status}: ${errText}` };
        }

        const data: any = await response.json().catch(() => null);
        return { success: true, status: response.status, messageId: data?.id };
      }
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

    const formattedContent = this.formatContent(options.content);
    const editUrl = this.buildEditUrl(messageId);

    try {
      if (options.fileBuffer) {
        const formData = new FormData();
        const fileName = options.fileName || `cropped_${Date.now()}.png`;
        const blob = new Blob([options.fileBuffer], { type: 'image/png' });
        formData.append('files[0]', blob, fileName);

        const payloadJson: any = {
          content: formattedContent,
          allowed_mentions: { parse: [] }
        };

        formData.append('payload_json', JSON.stringify(payloadJson));

        const response = await fetch(editUrl, {
          method: 'PATCH',
          body: formData
        });

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

        const response = await fetch(editUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

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
