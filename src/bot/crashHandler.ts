import { WebhookService } from './webhook';
import { spawn } from 'child_process';
import { ConsoleLogger } from './consoleLogger';

export class CrashHandler {
  private static isCrashing = false;
  private static webhookService: WebhookService | null = null;
  private static onCrashCallback?: (err: Error | any) => void;

  public static init(webhook: WebhookService, onCrash?: (err: Error | any) => void): void {
    this.webhookService = webhook;
    this.onCrashCallback = onCrash;

    // Handle Uncaught Exceptions
    process.on('uncaughtException', async (error: Error) => {
      await this.handleCrash('Uncaught Exception', error);
    });

    // Handle Unhandled Promise Rejections
    process.on('unhandledRejection', async (reason: any) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      await this.handleCrash('Unhandled Promise Rejection', error);
    });
  }

  public static setWebhookService(webhook: WebhookService): void {
    this.webhookService = webhook;
  }

  public static async handleCrash(type: string, error: Error): Promise<void> {
    if (this.isCrashing) return;
    this.isCrashing = true;

    ConsoleLogger.error(error, type);

    const errorMessage = error?.message || 'Unknown error';

    // Send alert message to Discord via Webhook
    if (this.webhookService && this.webhookService.isConfigured()) {
      try {
        const text = `-# **crashed** *(${type}: ${errorMessage.slice(0, 120)})* • restarting`;

        await this.webhookService.send({
          content: text
        });
      } catch (webhookErr) {
        // silent
      }
    }

    if (this.onCrashCallback) {
      try {
        this.onCrashCallback(error);
      } catch (e) {
        // ignore
      }
    }

    // Give 1 second for socket/webhook flush, then restart
    setTimeout(() => {
      this.restartProcess();
    }, 1000);
  }

  public static restartProcess(): void {
    ConsoleLogger.restarted();

    if (process.env.MANAGED_BY_RUNNER === 'true') {
      process.exit(1);
    } else {
      try {
        const subprocess = spawn(process.argv[0], process.argv.slice(1), {
          detached: true,
          stdio: 'inherit',
          cwd: process.cwd(),
          env: { ...process.env, BOT_RESTARTED: '1' }
        });
        subprocess.unref();
      } catch (err) {
        ConsoleLogger.error(err, 'restart spawn');
      }
      process.exit(1);
    }
  }
}
