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

      const homeDir = process.env.HOME || os.homedir() || '';
      const sharedDirs = [
        path.resolve(homeDir, 'storage/shared/autoclick'),
        '/sdcard/autoclick',
        '/storage/emulated/0/autoclick'
      ];
      let targetDir = sharedDirs[0];
      for (const dir of sharedDirs) {
        if (fs.existsSync(dir) || fs.existsSync(path.dirname(dir))) {
          targetDir = dir;
          break;
        }
      }
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

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

  app.listen(PORT, '0.0.0.0', () => {
    if (!process.env.BOT_RESTARTED) {
      ConsoleLogger.started();
    }
    botManager.addLog(`Server started on port ${PORT}`, 'info');
  });
}

startServer().catch((err) => ConsoleLogger.error(err, 'server start'));
