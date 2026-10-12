import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { botManager } from './src/bot/botManager';
import { RefImageManager } from './src/bot/refImage';
import { TemplateMatcher } from './src/bot/matcher';
import { ConsoleLogger } from './src/bot/consoleLogger';
import { LiveController, LIVE_PORT } from './src/bot/liveController';
import { MacroManager } from './src/bot/macroManager';
import { screenRuleManager } from './src/bot/screenRuleManager';
import { StoragePaths } from './src/bot/storagePaths';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // API Endpoints
  app.get('/api/status', async (_req, res) => {
    try {
      const status = await botManager.getStatus();
      res.json({ success: true, ...status });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/config', (_req, res) => {
    const config = botManager.getConfig();
    // Mask token partially for safety in display
    res.json({
      success: true,
      config: {
        ...config,
        discordTokenMasked: config.discordToken ? `${config.discordToken.slice(0, 8)}••••••••` : '',
      }
    });
  });

  app.post('/api/config', (req, res) => {
    try {
      const updated = botManager.updateConfig(req.body);
      res.json({ success: true, config: updated });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/bot/start', async (req, res) => {
    try {
      const { token } = req.body;
      const config = botManager.getConfig();
      const botToken = token || config.discordToken;
      const result = await botManager.getDiscordBot().start(botToken);
      if (token && result.success) {
        botManager.updateConfig({ discordToken: token });
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/bot/stop', async (_req, res) => {
    try {
      const result = await botManager.getDiscordBot().stop();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/commands', (_req, res) => {
    const commands = botManager.getCommands();
    res.json({ success: true, commands });
  });

  app.get('/api/ai/learned', async (_req, res) => {
    try {
      const { aiLearner } = await import('./src/bot/aiLearner');
      res.json({
        success: true,
        storageDir: aiLearner.getStorageDir(),
        prompts: aiLearner.getLearnedPrompts()
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/ai/learned/:id', async (req, res) => {
    try {
      const { aiLearner } = await import('./src/bot/aiLearner');
      const forgotten = aiLearner.forgetPrompt(req.params.id);
      res.json({ success: forgotten });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/command/run', async (req, res) => {
    try {
      const { name, args } = req.body;
      if (!name) {
        return res.status(400).json({ success: false, message: 'Command name is required' });
      }
      const result = await botManager.executeCommand(name, Array.isArray(args) ? args : []);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/adb/devices', async (_req, res) => {
    try {
      const devices = await botManager.getAdbController().getDevices();
      const isAvailable = await botManager.getAdbController().isAdbAvailable();
      res.json({ success: true, adbAvailable: isAvailable, devices });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/adb/connect', async (req, res) => {
    try {
      const { host } = req.body;
      if (!host) {
        return res.status(400).json({ success: false, message: 'Host (IP:PORT) is required' });
      }
      const result = await botManager.getAdbController().connectTcp(host);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/adb/tap', async (req, res) => {
    try {
      const { x, y, minX, maxX, minY, maxY } = req.body;
      const adb = botManager.getAdbController();
      let result;
      if (minX !== undefined && maxX !== undefined && minY !== undefined && maxY !== undefined) {
        result = await adb.tapRandomRange(Number(minX), Number(maxX), Number(minY), Number(maxY));
      } else {
        result = await adb.tap(Number(x), Number(y));
      }
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/adb/screenshot', async (_req, res) => {
    try {
      const adb = botManager.getAdbController();
      const buffer = await adb.screencap();
      res.setHeader('Content-Type', 'image/png');
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/ref/image', async (_req, res) => {
    try {
      const base64 = await RefImageManager.getRefBase64();
      const refPath = RefImageManager.getRefPath();
      res.json({ success: true, path: refPath, base64 });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/ref/image', async (req, res) => {
    try {
      const { base64 } = req.body;
      if (!base64) {
        return res.status(400).json({ success: false, message: 'Base64 image data required' });
      }
      const cleanBase64 = base64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(cleanBase64, 'base64');
      await RefImageManager.saveRefImage(buffer);
      botManager.addLog('Updated ref/pfp.jpg reference template image', 'info');
      res.json({ success: true, message: 'Reference image updated successfully' });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/ref/reset-default', async (_req, res) => {
    try {
      await RefImageManager.generateDefaultPfp();
      const base64 = await RefImageManager.getRefBase64();
      res.json({ success: true, message: 'Generated default ref/pfp.jpg', base64 });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/matcher/test', async (req, res) => {
    try {
      const { customScreenshotBase64, threshold, scales } = req.body;
      const adb = botManager.getAdbController();
      let screenBuffer: Buffer;

      if (customScreenshotBase64) {
        const clean = customScreenshotBase64.replace(/^data:image\/\w+;base64,/, '');
        screenBuffer = Buffer.from(clean, 'base64');
      } else {
        screenBuffer = await adb.screencap();
      }

      const refPath = await RefImageManager.ensureRefImage();
      const config = botManager.getConfig();

      const result = await TemplateMatcher.match(screenBuffer, refPath, {
        scales: scales || config.scales,
        threshold: threshold !== undefined ? Number(threshold) : config.matchThreshold,
        drawDebugBox: true
      });

      res.json({
        success: true,
        matchResult: result
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/updater/check', async (_req, res) => {
    try {
      const updater = botManager.getAutoUpdater();
      const status = await updater.checkForUpdates();
      res.json({ success: true, ...status });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/updater/pull', async (_req, res) => {
    try {
      const updater = botManager.getAutoUpdater();
      const result = await updater.pullAndRestart();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/bot/restart', (_req, res) => {
    res.json({ success: true, message: 'Restart initiated' });
    setTimeout(async () => {
      const { CrashHandler } = await import('./src/bot/crashHandler');
      CrashHandler.restartProcess();
    }, 500);
  });

  app.post('/api/bot/crash-test', (_req, res) => {
    res.json({ success: true, message: 'Simulating crash in 500ms...' });
    setTimeout(() => {
      throw new Error('Deliberate test crash triggered from Web Panel to verify Discord crash alerts & auto-recovery');
    }, 500);
  });

  app.get('/api/logs', (_req, res) => {
    res.json({ success: true, logs: botManager.getLogs() });
  });

  app.delete('/api/logs', (_req, res) => {
    botManager.clearLogs();
    res.json({ success: true });
  });

  // =========================================================================
  // LIVE BROWSER REMOTE CONTROL & CLOUDFLARE TUNNEL ENDPOINTS (Port 4444)
  // =========================================================================
  app.get('/api/live/status', (_req, res) => {
    res.json({
      success: true,
      tunnel: LiveController.getStatus(),
      runningMacro: MacroManager.getRunningMacro(),
      isFindRunning: MacroManager.isFindRunning(),
      startState: MacroManager.loadStartState()
    });
  });

  app.post('/api/live/start', async (req, res) => {
    try {
      const mode = req.body?.mode === 'local' ? 'local' : req.body?.mode === 'net' ? 'net' : 'all';
      const status = await LiveController.startLiveTunnel(
        LIVE_PORT,
        (msg) => botManager.addLog(msg, 'info'),
        mode
      );
      res.json({ success: true, tunnel: status });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/live/stop', async (_req, res) => {
    const status = await LiveController.stopLiveTunnel();
    res.json({ success: true, tunnel: status });
  });

  app.post('/api/live/stop-scripts', async (_req, res) => {
    try {
      const stopped = await LiveController.stopAllLocalScriptsForLive((msg) =>
        botManager.addLog(msg, 'info')
      );
      res.json({ success: true, stoppedMacro: stopped });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/live/h264-stream', async (req, res) => {
    if (!LiveController.isActive()) {
      return res.status(403).json({ success: false, message: 'Live Control is OFF. Send "live" in Discord to activate port 4444.' });
    }
    try {
      await LiveController.streamH264(req, res);
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: err.message });
      }
    }
  });

  app.get('/api/live/raw-frame', async (req, res) => {
    if (!LiveController.isActive()) {
      return res.status(403).json({ success: false, message: 'Live Control is OFF. Send "live" in Discord to activate port 4444.' });
    }
    try {
      const forceFresh = req.query.fresh === '1';
      const frame = await LiveController.captureLiveFrame(forceFresh);
      const qMode = LiveController.getStreamQualityMode(req);
      const rawData = LiveController.getOrCreateRawRgbaGzip(frame, qMode);

      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('X-Screen-Width', String(frame.width));
      res.setHeader('X-Screen-Height', String(frame.height));
      res.setHeader('X-Raw-Width', String(rawData.w));
      res.setHeader('X-Raw-Height', String(rawData.h));
      res.send(rawData.gzipBuf);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/live/frame', async (req, res) => {
    if (!LiveController.isActive()) {
      return res.status(403).json({ success: false, message: 'Live Control is OFF. Send "live" in Discord to activate port 4444.' });
    }
    try {
      const forceFresh = req.query.fresh === '1';
      const frame = await LiveController.captureLiveFrame(forceFresh);
      const qMode = LiveController.getStreamQualityMode(req);

      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('X-Screen-Width', String(frame.width));
      res.setHeader('X-Screen-Height', String(frame.height));

      if (qMode !== 'hd') {
        const jpegBuf = await LiveController.getOrCreateFastJpeg(frame, qMode);
        res.setHeader('Content-Type', 'image/jpeg');
        res.send(jpegBuf);
      } else {
        const pngBuf = await LiveController.getOrCreateFullPng(frame);
        res.setHeader('Content-Type', 'image/png');
        res.send(pngBuf);
      }
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/live/tap', async (req, res) => {
    if (!LiveController.isActive()) {
      return res.status(403).json({ success: false, message: 'Live Control is OFF.' });
    }
    try {
      const x = Math.round(Number(req.body.x) || 0);
      const y = Math.round(Number(req.body.y) || 0);
      const adb = botManager.getAdbController();
      const result = await adb.tap(x, y);
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/live/swipe', async (req, res) => {
    if (!LiveController.isActive()) {
      return res.status(403).json({ success: false, message: 'Live Control is OFF.' });
    }
    try {
      const x1 = Math.round(Number(req.body.x1) || 0);
      const y1 = Math.round(Number(req.body.y1) || 0);
      const x2 = Math.round(Number(req.body.x2) || 0);
      const y2 = Math.round(Number(req.body.y2) || 0);
      const durationMs = Math.max(80, Math.round(Number(req.body.durationMs) || 300));
      const adb = botManager.getAdbController();
      await adb.swipe(x1, y1, x2, y2, durationMs);
      res.json({ success: true, x1, y1, x2, y2, durationMs });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/live/key', async (req, res) => {
    if (!LiveController.isActive()) {
      return res.status(403).json({ success: false, message: 'Live Control is OFF.' });
    }
    try {
      const keyCode = req.body.keyCode ?? 4;
      const adb = botManager.getAdbController();
      await adb.keyEvent(keyCode);
      res.json({ success: true, keyCode });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/live/text', async (req, res) => {
    if (!LiveController.isActive()) {
      return res.status(403).json({ success: false, message: 'Live Control is OFF.' });
    }
    try {
      const text = String(req.body.text || '');
      if (!text) return res.status(400).json({ success: false, message: 'Text is required' });
      const adb = botManager.getAdbController();
      await adb.inputText(text);
      res.json({ success: true, text });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/live/crop-save', async (req, res) => {
    if (!LiveController.isActive()) {
      return res.status(403).json({ success: false, message: 'Live Control is OFF.' });
    }
    try {
      const minX = Math.round(Number(req.body.minX) || 0);
      const maxX = Math.round(Number(req.body.maxX) || 100);
      const minY = Math.round(Number(req.body.minY) || 0);
      const maxY = Math.round(Number(req.body.maxY) || 100);
      const rawName = String(req.body.fileName || `crop_${Date.now()}.png`).trim();
      const cleanName = path.basename(rawName);
      const savedFileName = /\.(png|jpg|jpeg)$/i.test(cleanName) ? cleanName : `${cleanName}.png`;

      const last = LiveController.getLastFrame() || (await LiveController.captureLiveFrame(true));
      const lowX = Math.max(0, Math.min(minX, maxX));
      const highX = Math.min(last.width, Math.max(minX, maxX));
      const lowY = Math.max(0, Math.min(minY, maxY));
      const highY = Math.min(last.height, Math.max(minY, maxY));
      const croppedBuffer = await TemplateMatcher.cropRawToPng(last.rawScreen, {
        minX: lowX,
        maxX: highX,
        minY: lowY,
        maxY: highY
      });
      const cropped = {
        buffer: croppedBuffer,
        width: Math.max(1, highX - lowX),
        height: Math.max(1, highY - lowY)
      };

      const targetDir = StoragePaths.getImagesDir();
      const fullSavePath = path.join(targetDir, savedFileName);
      await fs.promises.writeFile(fullSavePath, cropped.buffer);
      botManager.addLog(`💾 [Live Crop] Saved ${savedFileName} (${cropped.width}x${cropped.height}) to ${fullSavePath}`, 'info');

      res.json({
        success: true,
        fileName: savedFileName,
        path: fullSavePath,
        width: cropped.width,
        height: cropped.height
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Screen Rules (Zero AI Prompt & Screen Handlers)
  app.get('/api/screen-rules', (_req, res) => {
    try {
      const rules = screenRuleManager.getRules();
      const latestPending = screenRuleManager.getLatestPendingScreen();
      res.json({
        success: true,
        rules,
        storageDir: screenRuleManager.getStorageDir(),
        latestPending: latestPending
          ? {
              id: latestPending.id,
              keywords: latestPending.keywords,
              ocrSnippet: latestPending.ocrSnippet,
              macroName: latestPending.macroName,
              stepNumber: latestPending.stepNumber,
              timestamp: latestPending.timestamp,
              screenshotBase64: latestPending.screenshotBuffer.toString('base64')
            }
          : null
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/screen-rules/set', (req, res) => {
    try {
      const { id, action, keywords, snippet } = req.body;
      if (!id || !action || !action.type) {
        return res.status(400).json({ success: false, message: 'id and action.type are required' });
      }
      const rule = screenRuleManager.setRule(id, action, { keywords, snippet });
      res.json({ success: true, rule });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/screen-rules/rename', (req, res) => {
    try {
      const { oldId, newId } = req.body;
      if (!oldId || !newId) {
        return res.status(400).json({ success: false, message: 'oldId and newId are required' });
      }
      const result = screenRuleManager.renameRule(oldId, newId);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/screen-rules/pending-id', (req, res) => {
    try {
      const { newId } = req.body;
      if (!newId) {
        return res.status(400).json({ success: false, message: 'newId is required' });
      }
      const ok = screenRuleManager.setPendingId(newId);
      res.json({ success: ok });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.delete('/api/screen-rules/:id', (req, res) => {
    try {
      const deleted = screenRuleManager.deleteRule(req.params.id);
      res.json({ success: deleted });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/screen-rules/scan', async (_req, res) => {
    try {
      const adb = botManager.getAdbController();
      const checkRes = await screenRuleManager.checkAndExecuteRule(adb);
      if (checkRes.matched && checkRes.rule) {
        return res.json({ success: true, matched: true, rule: checkRes.rule });
      }
      const webhook = botManager.getWebhookService();
      const pending = await screenRuleManager.handleUnknownScreen(adb, webhook, {
        commandName: 'scan',
        args: [],
        log: (m) => botManager.addLog(m, 'info')
      }, {
        macroName: 'web-scan',
        stepNumber: 0,
        targetName: 'current-screen'
      });
      res.json({
        success: true,
        matched: false,
        pending: {
          id: pending.id,
          keywords: pending.keywords,
          ocrSnippet: pending.ocrSnippet,
          screenshotBase64: pending.screenshotBuffer.toString('base64')
        }
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Wi-Fi Debug Keeper APK Download Endpoints
  const apkFilePath = path.resolve(__dirname, 'public', 'downloads', 'wifi-debug-keeper.apk');

  app.get(['/api/download/wifi-debug-keeper.apk', '/api/download/apk', '/downloads/wifi-debug-keeper.apk'], (_req, res) => {
    if (fs.existsSync(apkFilePath)) {
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="wifi-debug-keeper.apk"');
      res.sendFile(apkFilePath);
    } else {
      res.status(404).json({ success: false, message: 'APK file not found. Please build or check public/downloads.' });
    }
  });

  // Serve static public assets
  app.use(express.static(path.resolve(__dirname, 'public')));

  // Vite development / Production static file handler
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  const handleShutdown = async () => {
    try {
      const { MacroManager } = await import('./src/bot/macroManager');
      const { stopHold, stopFarm } = await import('./src/bot/commands/index');
      const { stopSub } = await import('./src/bot/commands/sub');
      MacroManager.stopAll();
      stopHold();
      stopFarm();
      stopSub();
      await botManager.getAdbController().stopAllTaps().catch(() => {});
    } catch {}
    ConsoleLogger.stopped();
    process.exit(0);
  };

  process.on('SIGINT', () => void handleShutdown());
  process.on('SIGTERM', () => void handleShutdown());

  app.listen(Number(PORT), '0.0.0.0', () => {
    if (!process.env.BOT_RESTARTED) {
      ConsoleLogger.started();
    }
    botManager.addLog(`Server started on port ${PORT}`, 'info');
  });
}

startServer().catch((err) => ConsoleLogger.error(err, 'server start'));
