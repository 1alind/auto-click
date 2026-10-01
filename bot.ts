import { botManager } from './src/bot/botManager';
import { RefImageManager } from './src/bot/refImage';
import { ConsoleLogger } from './src/bot/consoleLogger';

process.on('SIGINT', () => {
  ConsoleLogger.stopped();
  process.exit(0);
});

process.on('SIGTERM', () => {
  ConsoleLogger.stopped();
  process.exit(0);
});

async function main() {
  await RefImageManager.ensureRefImage();
  const config = botManager.getConfig();
  const configPath = botManager.getConfigFilePath();

  const token = config.discordToken || process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    ConsoleLogger.error(`No Discord token found in ${configPath}`, 'config');
  } else {
    const result = await botManager.getDiscordBot().start(token);
    if (!result.success) {
      ConsoleLogger.error(result.message, 'discord login');
    }
  }

  // Ensure Auto-Updater is running (strictly 1 minute interval)
  botManager.getAutoUpdater().startPeriodicCheck(1, true);

  if (!process.env.BOT_RESTARTED) {
    ConsoleLogger.started();
  }
}

main().catch((err) => {
  ConsoleLogger.error(err, 'startup');
});
