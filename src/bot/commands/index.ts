import { CommandDefinition, CommandContext, CommandResult } from '../types';
import { StoragePaths } from '../storagePaths';

export const tapCommand: CommandDefinition = {
  name: 'tap',
  description: 'Taps exact coordinate or random range on Android device (with optional hold duration).',
  usage: 'tap <x> <y> [durationMs/seconds]  OR  tap <xMin-xMax> <yMin-yMax> [durationMs/seconds]',
  aliases: ['click', 'input-tap'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const adb = botManager.getAdbController();

    if (ctx.args.length < 2) {
      const msg = 'usage: tap <x> <y> [duration]';
      if (ctx.reply) await ctx.reply(msg);
      return { success: false, message: msg };
    }

    const argX = ctx.args[0];
    const argY = ctx.args[1];
    const durArg = ctx.args[2];
    let holdDurationMs: number | undefined;

    if (durArg) {
      const clean = durArg.toLowerCase().trim();
      if (clean.endsWith('ms')) {
        holdDurationMs = parseInt(clean, 10);
      } else if (clean.endsWith('s')) {
        holdDurationMs = Math.round(parseFloat(clean) * 1000);
      } else {
        const v = parseFloat(clean);
        if (!isNaN(v)) {
          holdDurationMs = v > 0 && v <= 30 && clean.includes('.') ? Math.round(v * 1000) : Math.round(v);
        }
      }
    }

    if (holdDurationMs !== undefined) {
      holdDurationMs = Math.max(50, holdDurationMs);
    }

    let result;
    if (argX.includes('-') || argY.includes('-')) {
      const [minX, maxX] = argX.split('-').map(Number);
      const [minY, maxY] = argY.split('-').map(Number);
      if (isNaN(minX) || isNaN(maxX) || isNaN(minY) || isNaN(maxY)) {
        const msg = 'invalid range';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }
      if (holdDurationMs && holdDurationMs > 0) {
        result = await adb.holdRandomRange(minX, maxX, minY, maxY, holdDurationMs);
      } else {
        result = await adb.tapRandomRange(minX, maxX, minY, maxY);
      }
    } else {
      const x = parseInt(argX, 10);
      const y = parseInt(argY, 10);
      if (isNaN(x) || isNaN(y)) {
        const msg = 'invalid coordinates';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }
      if (holdDurationMs && holdDurationMs > 0) {
        result = await adb.hold(x, y, holdDurationMs);
      } else {
        result = await adb.tap(x, y);
      }
    }

    const output = (holdDurationMs && holdDurationMs > 0)
      ? `held (${result.x}, ${result.y}) for ${result.durationMs || holdDurationMs}ms`
      : `tapped (${result.x}, ${result.y})`;
    ctx.log(output, 'info');
    if (ctx.reply) await ctx.reply(output);
    return { success: true, message: output, data: result };
  }
};

let holdRunning = false;
let holdStopRequested = false;

export function isHoldRunning(): boolean {
  return holdRunning;
}

export function stopHold(): boolean {
  if (!holdRunning) return false;
  holdStopRequested = true;
  return true;
}

export const holdCommand: CommandDefinition = {
  name: 'hold',
  description: 'Holds coordinates or range on device for a duration specified in minutes.',
  usage: 'hold silver <time-in-minutes>  OR  hold <xrange> <yrange> <time-in-minutes>',
  aliases: ['longpress', 'press', 'input-hold'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const { MacroManager } = await import('../macroManager');
    const adb = botManager.getAdbController();

    let minX: number;
    let maxX: number;
    let minY: number;
    let maxY: number;
    let isRange = false;
    let targetLabel = '';
    let durArg = '';

    // Check if user is using named preset targets, e.g. "hold silver 10" or "hold silver 5m"
    const firstArg = ctx.args[0]?.trim().toLowerCase();
    if (firstArg === 'silver') {
      if (ctx.args.length < 2) {
        const msg = 'usage: `hold silver <time-in-minutes>` (e.g. `hold silver 10`)';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }
      minX = 677;
      maxX = 955;
      minY = 1946;
      maxY = 2099;
      isRange = true;
      targetLabel = 'silver [677-955 1946-2099]';
      durArg = ctx.args[1].trim();
    } else {
      if (ctx.args.length < 3) {
        const msg = 'usage: `hold <xrange> <yrange> <time-in-minutes>` or `hold silver <time>` (e.g. `hold silver 10`, `hold 123-345 56-738 5`)';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      const argX = ctx.args[0].trim();
      const argY = ctx.args[1].trim();
      durArg = ctx.args[2].trim();

      if (argX.includes('-')) {
        isRange = true;
        const parts = argX.split('-').map(Number);
        minX = parts[0];
        maxX = parts[1];
      } else {
        const x = Number(argX);
        minX = x;
        maxX = x;
      }

      if (argY.includes('-')) {
        isRange = true;
        const parts = argY.split('-').map(Number);
        minY = parts[0];
        maxY = parts[1];
      } else {
        const y = Number(argY);
        minY = y;
        maxY = y;
      }

      if (isNaN(minX) || isNaN(maxX) || isNaN(minY) || isNaN(maxY)) {
        const msg = 'invalid coordinates or range (e.g. `hold silver 10` or `hold 123-345 56-738 5`)';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      targetLabel = isRange ? `${argX} ${argY}` : `(${minX}, ${minY})`;
    }

    const cleanDur = durArg.toLowerCase();
    let durationMinutes = 1;

    if (cleanDur.endsWith('ms')) {
      durationMinutes = parseFloat(cleanDur) / 60000;
    } else if (cleanDur.endsWith('s') && !cleanDur.endsWith('mins')) {
      durationMinutes = parseFloat(cleanDur) / 60;
    } else {
      const parsed = parseFloat(cleanDur.replace(/(m|min|mins)$/i, ''));
      if (isNaN(parsed) || parsed <= 0) {
        const msg = 'invalid time-in-minutes (e.g. `hold silver 10` or `hold 123-345 56-738 5`)';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }
      durationMinutes = parsed;
    }

    const durationMs = Math.max(100, Math.round(durationMinutes * 60 * 1000));
    const targetDesc = targetLabel;
    const minDesc = durationMinutes >= 1 ? `${durationMinutes} minute(s)` : `${Math.round(durationMs / 1000)}s`;

    holdRunning = true;
    holdStopRequested = false;
    MacroManager.setRunningMacro('hold');

    const startMsg = `-# ⏱️ holding ${targetDesc} for ${minDesc}... (send "stop" to cancel)`;
    ctx.log(startMsg, 'info');
    if (ctx.reply) await ctx.reply(startMsg);

    const checkCancelled = () => holdStopRequested || MacroManager.getRunningMacro() !== 'hold';

    let result;
    try {
      if (isRange) {
        result = await adb.holdRandomRange(minX, maxX, minY, maxY, durationMs, checkCancelled);
      } else {
        result = await adb.hold(minX, minY, durationMs, checkCancelled);
      }
    } finally {
      holdRunning = false;
      if (MacroManager.getRunningMacro() === 'hold') {
        MacroManager.setRunningMacro(null);
      }
    }

    const stoppedEarly = holdStopRequested || !result.success || (result.durationMs && result.durationMs < durationMs - 500);
    const finishMsg = stoppedEarly
      ? `-# 🛑 held (${result.x}, ${result.y}) stopped early and touches released (${result.durationMs ? Math.round(result.durationMs / 1000) + 's' : 'cancelled'})`
      : `-# ✅ held (${result.x}, ${result.y}) for ${minDesc}`;

    ctx.log(finishMsg, 'info');
    if (ctx.reply) await ctx.reply(finishMsg);

    return { success: true, message: finishMsg, data: result };
  }
};

export const screenshotCommand: CommandDefinition = {
  name: 'screenshot',
  description: 'Takes a screenshot (full, center-crop, or X/Y range) and optionally saves it to sdcard/autoclick.',
  usage: 'screenshot [minX-maxX minY-maxY] [save [filename]]',
  aliases: ['screenshoot', 'screencap', 'screen', 'snap', 'ss', 'sc'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const { TemplateMatcher } = await import('../matcher');
    const fs = await import('fs');
    const path = await import('path');
    const adb = botManager.getAdbController();
    const discord = botManager.getDiscordBot();

    let fullPng: Buffer;
    try {
      fullPng = await adb.screencap();
    } catch (err: any) {
      const errMsg = `screenshot failed: ${err.message}`;
      if (ctx.reply) await ctx.reply(errMsg);
      return { success: false, message: errMsg };
    }

    let finalBuffer = fullPng;
    let labelText = '-# 📸 screenshot captured';
    let shouldSave = false;
    let savedFileName = `screenshot_${Date.now()}.png`;

    const args = ctx.args || [];
    let rangeArg: string | undefined;

    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === 'save') {
        shouldSave = true;
        if (args[i + 1] && !args[i + 1].startsWith('-')) {
          savedFileName = args[i + 1].endsWith('.png') ? args[i + 1] : `${args[i + 1]}.png`;
          i++;
        }
      } else if (a === 'crop') {
        const cropped = await TemplateMatcher.cropCenter(fullPng, 150, 150).catch(() => null);
        if (cropped) {
          finalBuffer = cropped;
          labelText = '-# 📸 screenshot center crop (150x150)';
        }
      } else if (a.includes('-') && !rangeArg) {
        rangeArg = a;
        const nextArg = args[i + 1];
        if (nextArg && nextArg.includes('-')) {
          const [minX, maxX] = a.split('-').map(Number);
          const [minY, maxY] = nextArg.split('-').map(Number);
          if (!isNaN(minX) && !isNaN(maxX) && !isNaN(minY) && !isNaN(maxY)) {
            const cropRes = await TemplateMatcher.cropRegion(fullPng, minX, minY, maxX, maxY).catch(() => null);
            if (cropRes && cropRes.buffer) {
              finalBuffer = cropRes.buffer;
              labelText = `-# 📸 screenshot cropped (${minX}-${maxX} ${minY}-${maxY})`;
              i++;
            }
          }
        }
      }
    }

    if (shouldSave) {
      const saveDir = '/sdcard/autoclick';
      try {
        if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
        fs.writeFileSync(path.join(saveDir, savedFileName), finalBuffer);
        labelText += ` (saved to ${savedFileName})`;
      } catch (saveErr: any) {
        ctx.log(`Failed to save screenshot to sdcard: ${saveErr.message}`, 'warn');
      }
    }

    if (discord.isConnected()) {
      await discord.updateDashboard({
        content: labelText,
        fileBuffer: finalBuffer,
        fileName: savedFileName
      });
      ctx.log('✅ Screenshot sent via Discord Bot', 'info');
    } else if (shouldSave && ctx.reply) {
      await ctx.reply(labelText);
    }

    const base64 = `data:image/png;base64,${finalBuffer.toString('base64')}`;
    return {
      success: true,
      message: shouldSave ? `saved ${savedFileName}` : 'screenshot',
      data: { base64, size: finalBuffer.length, fileName: shouldSave ? savedFileName : undefined }
    };
  }
};

export const devicesCommand: CommandDefinition = {
  name: 'devices',
  description: 'Lists all connected ADB physical devices and emulators.',
  usage: 'devices',
  aliases: ['adb-devices', 'list-devices', 'devs'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const adb = botManager.getAdbController();
    const devices = await adb.getDevices();

    const output = devices.length === 0
      ? 'no devices'
      : devices.map((d) => `${d.serial} (${d.state})`).join('\n');

    ctx.log(output, 'info');
    if (ctx.reply) await ctx.reply(output);
    return { success: true, message: output, data: { devices } };
  }
};

export const statusCommand: CommandDefinition = {
  name: 'status',
  description: 'Shows Discord bot runtime status, real ADB device connection state, active macro, and start stats.',
  usage: 'status',
  aliases: ['info', 'ping', 'check'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const { MacroManager } = await import('../macroManager');
    const { getRunningSubOption } = await import('./sub');
    const status = await botManager.getStatus();

    const onlineDevice = status.devices.find((d) => d.state === 'device');
    const anyDevice = status.devices[0];
    const adbStatusText = onlineDevice
      ? `connected (${onlineDevice.serial})`
      : anyDevice
      ? `${anyDevice.state} (${anyDevice.serial})`
      : 'disconnected';

    const runningMacro = MacroManager.getRunningMacro();
    const isFindRunning = MacroManager.isFindRunning();
    const runningSub = getRunningSubOption();
    const startState = MacroManager.loadStartState();

    const taskText = isFindRunning
      ? 'running `find`'
      : runningSub
      ? `running \`sub ${runningSub}\``
      : runningMacro
      ? runningMacro.toLowerCase() === 'start'
        ? `running \`start\` (step ${startState.currentStep}, cycle #${startState.cycleCount}, AS: ${startState.asCount || 0}, AC-Fix: ${startState.acFixCount || 0}, repair: ${startState.repairCount || 0})`
        : `running \`${runningMacro}\``
      : `idle (start cycles: ${startState.cycleCount}, last step: ${startState.currentStep})`;

    const totalSec = Math.floor(process.uptime());
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const uptimeText =
      hrs > 0 ? `${hrs}h ${mins}m ${secs}s` : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    const output = `online | adb: ${adbStatusText} | task: ${taskText} | uptime: ${uptimeText}`;

    ctx.log('Queried bot status', 'info');
    if (ctx.reply) await ctx.reply(output);
    return { success: true, message: output, data: status };
  }
};

export const buttonsCommand: CommandDefinition = {
  name: 'buttons',
  description: 'Displays Discord interactive control buttons (Start, Stop, Fixac, Status, Screenshot).',
  usage: 'buttons',
  aliases: ['panel', 'controls', 'menu', 'btn'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const { MacroManager } = await import('../macroManager');
    const { createControlButtons } = await import('../discordButtons');

    const isRunning = MacroManager.isStartRunning();
    const content = isRunning
      ? '-# 🎮 **Control Panel** (airstrike: `working`)\n-# Tap a button below to control the bot:'
      : '-# 🎮 **Control Panel** (airstrike: `idle`)\n-# Tap a button below to control the bot:';

    const discord = botManager.getDiscordBot();
    if (discord.isConnected()) {
      await discord.updateDashboard({
        content,
        rawContent: true,
        isRunning
      });
    }

    return { success: true, message: 'control panel displayed' };
  }
};

export const updateCommand: CommandDefinition = {
  name: 'update',
  description: 'Checks GitHub for updates, pulls latest code (git pull), and restarts the bot.',
  usage: 'update',
  aliases: ['pull', 'gitpull', 'upgrade'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const updater = botManager.getAutoUpdater();

    ctx.log('Checking GitHub updates via update command...', 'info');
    const result = await updater.pullAndRestart();
    // Note: pullAndRestart() already sends "updated" (or "update failed: ...") via webhook when finished
    return result;
  }
};

export const checkUpdateCommand: CommandDefinition = {
  name: 'checkupdate',
  description: 'Checks GitHub for new commits/versions without pulling.',
  usage: 'checkupdate',
  aliases: ['version', 'check-version', 'v'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const updater = botManager.getAutoUpdater();

    ctx.log('Checking for new GitHub versions...', 'info');
    const info = await updater.checkForUpdates();

    let output = '';
    if (info.error) {
      output = `error: ${info.error}`;
    } else if (info.updateAvailable) {
      output = `update available (${info.latestCommit})`;
    } else {
      output = `up to date (${info.currentCommit})`;
    }

    if (ctx.reply) await ctx.reply(output);
    return { success: true, message: output, data: info };
  }
};

export const restartCommand: CommandDefinition = {
  name: 'restart',
  description: 'Gracefully restarts the automation bot process.',
  usage: 'restart',
  aliases: ['reboot', 'reload'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { CrashHandler } = await import('../crashHandler');
    const msg = 'restarting';
    if (ctx.reply) await ctx.reply(msg);
    ctx.log(msg, 'warn');

    setTimeout(() => {
      CrashHandler.restartProcess();
    }, 1000);

    return { success: true, message: msg };
  }
};

export const connectCommand: CommandDefinition = {
  name: 'connect',
  description: 'Connects to a local or remote ADB device over TCP/IP (great for Termux Wireless Debugging).',
  usage: 'connect <ip:port>  OR  connect <port>  OR  adb connect <ip:port>',
  aliases: ['adb-connect', 'tcpip', 'adb'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const { AdbController } = await import('../adb');
    const adb = botManager.getAdbController();

    let args = [...ctx.args];
    const firstArg = args[0]?.toLowerCase();

    // Support "adb connect <target>", "adb pair <target> <code>", "adb devices"
    if (firstArg === 'devices') {
      return await devicesCommand.execute(ctx);
    }

    if (firstArg === 'pair') {
      args = args.slice(1);
      if (args.length < 2) {
        const msg = 'usage: adb pair <ip:port> <code>';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }
      const host = AdbController.normalizeHost(args[0]);
      const code = args[1];
      const pairRes = await adb.pair(host, code);
      const out = pairRes.success ? `paired ${host}` : `pair failed: ${pairRes.message}`;
      if (ctx.reply) await ctx.reply(out);
      return { success: pairRes.success, message: out, data: pairRes };
    }

    if (firstArg === 'connect') {
      args = args.slice(1);
    }

    if (args.length === 0) {
      const found = await adb.autoConnectWithRetry();
      if (found) {
        botManager.updateConfig({ adbHost: found, adbSerial: found });
        return { success: true, message: `connected ${found}` };
      }
      return { success: false, message: 'adb auto-connect stopped' };
    }

    const target = AdbController.normalizeHost(args[0]);

    ctx.log(`Connecting to ADB host: ${target}...`, 'info');
    const result = await adb.connectTcp(target);
    if (result.success) {
      botManager.updateConfig({ adbHost: target, adbSerial: target });
      const output = `connected to ${target}`;
      if (ctx.reply) await ctx.reply(output);
      return { success: true, message: output, data: result };
    }

    const output = `failed to connect to ${target}: ${result.message}`;
    if (ctx.reply) await ctx.reply(output);
    return { success: false, message: output, data: result };
  }
};

export const pairCommand: CommandDefinition = {
  name: 'pair',
  description: 'Pairs with an Android Wireless Debugging port and 6-digit pairing code.',
  usage: 'pair <ip:port> <code>  OR  pair <port> <code>',
  aliases: ['adb-pair'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const { AdbController } = await import('../adb');
    const adb = botManager.getAdbController();

    if (ctx.args.length < 2) {
      const msg = 'usage: pair <ip:port> <code>';
      if (ctx.reply) await ctx.reply(msg);
      return { success: false, message: msg };
    }

    const target = AdbController.normalizeHost(ctx.args[0]);
    const code = ctx.args[1];

    const result = await adb.pair(target, code);
    const output = result.success ? `paired ${target}` : `pair failed: ${result.message}`;
    if (ctx.reply) await ctx.reply(output);
    return { success: result.success, message: output, data: result };
  }
};

export const setTokenCommand: CommandDefinition = {
  name: 'settoken',
  description: 'Sets or updates the GitHub Personal Access Token for private repository updates.',
  usage: 'settoken <ghp_yourTokenHere>',
  aliases: ['token', 'githubtoken', 'pat'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');

    if (ctx.args.length === 0) {
      const currentToken = botManager.getConfig().githubToken;
      const isSet = Boolean(currentToken && currentToken.length > 5);
      const msg = isSet ? 'token set' : 'token not set';
      if (ctx.reply) await ctx.reply(msg);
      return { success: true, message: msg };
    }

    const token = ctx.args[0].trim();
    if (token.length < 10) {
      const msg = 'invalid token';
      if (ctx.reply) await ctx.reply(msg);
      return { success: false, message: msg };
    }

    botManager.updateConfig({ githubToken: token });

    const updater = botManager.getAutoUpdater();
    updater.setGitHubToken(token);
    await updater.ensureRemoteConfigured();

    if (ctx.reply) await ctx.reply('token saved');
    return { success: true, message: 'token saved' };
  }
};

export const crashTestCommand: CommandDefinition = {
  name: 'crash-test',
  description: 'Simulates a runtime exception to test Discord crash alert webhook & auto-restart.',
  usage: 'crash-test',
  aliases: ['test-crash', 'force-crash'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    ctx.log('Triggering simulated crash test...', 'warn');

    setTimeout(() => {
      throw new Error('crash-test');
    }, 500);

    return { success: true, message: 'crashing' };
  }
};

export const cleanupCommand: CommandDefinition = {
  name: 'cleanup',
  description: 'Triggers an automatic cleanup of all messages in the channel (except dashboard).',
  usage: 'cleanup',
  aliases: ['autoclean', 'autoclear'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const discord = botManager.getDiscordBot();
    
    ctx.log('🧹 Triggering immediate channel cleanup...', 'info');
    discord.saveChannelStatus(false);
    
    // Run cleanup immediately in background so command finishes cleanly
    void discord.purgeChannel().then((res) => {
      ctx.log(`✅ Cleanup finished: removed ${res.totalDeleted} message(s).`, 'info');
    });
    
    return { success: true, message: 'cleanup started in main channel' };
  }
};

export const macroCommand: CommandDefinition = {
  name: 'macro',
  description: 'Create, edit, run, list, and delete custom multi-step automation flows directly via Discord.',
  usage: 'macro <create|edit|add-step|remove-step|view|list|delete> [name] [args...]',
  aliases: ['micro', 'flow', 'steps', 'sequence'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { MacroManager } = await import('../macroManager');
    const { botManager } = await import('../botManager');
    MacroManager.init();

    const registerDirectMacroCommand = (macroName: string) => {
      const m = MacroManager.getMacro(macroName);
      if (!m) return;
      botManager.registerCommand({
        name: m.name,
        description: `Custom macro flow "${m.name}" (${m.steps.length} steps)`,
        usage: `${m.name}`,
        execute: async (c) => {
          const latest = MacroManager.getMacro(m.name) || m;
          return await MacroManager.executeMacro(latest, c);
        }
      });
    };

    const sub = ctx.args[0]?.toLowerCase();

    if (!sub || sub === 'list') {
      const list = MacroManager.getMacros();
      if (list.length === 0) {
        const msg = 'no macros';
        if (ctx.reply) await ctx.reply(msg);
        return { success: true, message: msg };
      }

      const text = list.map((m) => `${m.name} (${m.steps.length} steps)`).join('\n');
      if (ctx.reply) await ctx.reply(text);
      return { success: true, message: text, data: list };
    }

    if (sub === 'create' || sub === 'new') {
      const name = ctx.args[1]?.toLowerCase();
      if (!name) {
        const msg = 'usage: macro create <name> <steps>';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      const scriptText = ctx.args.slice(2).join(' ');
      if (!scriptText || scriptText.trim().length === 0) {
        const msg = 'usage: macro create <name> <steps>';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      const macro = MacroManager.parseMacroScript(name, scriptText, ctx.author);
      MacroManager.saveMacro(macro);
      registerDirectMacroCommand(macro.name);

      const summary = `saved ${macro.name} (${macro.steps.length} steps)`;
      if (ctx.reply) await ctx.reply(summary);
      return { success: true, message: summary, data: macro };
    }

    // Edit/replace a single step: macro edit <name> <stepNumber> <newStep...>
    if (sub === 'edit' || sub === 'set' || sub === 'replace') {
      const name = ctx.args[1]?.toLowerCase();
      const stepNum = parseInt(ctx.args[2], 10);
      const stepText = ctx.args.slice(3).join(' ');

      if (!name || isNaN(stepNum) || !stepText.trim()) {
        const msg = 'usage: macro edit <name> <step#> <new step>';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      const macro = MacroManager.getMacro(name);
      if (!macro) {
        const msg = 'macro not found';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      if (stepNum < 1 || stepNum > macro.steps.length) {
        const msg = `invalid step #${stepNum} (${name} has ${macro.steps.length} steps)`;
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      const parsed = MacroManager.parseMacroScript(name, stepText);
      if (parsed.steps.length === 0) {
        const msg = 'invalid step action';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      macro.steps.splice(stepNum - 1, 1, ...parsed.steps);
      macro.description = `Custom macro with ${macro.steps.length} steps`;
      MacroManager.saveMacro(macro);
      registerDirectMacroCommand(macro.name);

      const summary = `updated ${name} step ${stepNum} -> ${parsed.steps[0].label || parsed.steps[0].type}`;
      if (ctx.reply) await ctx.reply(summary);
      return { success: true, message: summary, data: macro };
    }

    // Add or insert a step:
    // macro add-step <name> <newStep...> (appends to end)
    // macro add-step <name> <step#> <newStep...> (inserts at step#)
    if (sub === 'add-step' || sub === 'addstep' || sub === 'append' || sub === 'insert' || sub === 'add') {
      const name = ctx.args[1]?.toLowerCase();
      if (!name) {
        const msg = 'usage: macro add-step <name> [step#] <step>';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      const macro = MacroManager.getMacro(name);
      if (!macro) {
        // If macro doesn't exist yet and 'add' was used, create it
        const scriptText = ctx.args.slice(2).join(' ');
        if (!scriptText.trim()) {
          const msg = 'usage: macro add-step <name> [step#] <step>';
          if (ctx.reply) await ctx.reply(msg);
          return { success: false, message: msg };
        }
        const created = MacroManager.parseMacroScript(name, scriptText, ctx.author);
        MacroManager.saveMacro(created);
        registerDirectMacroCommand(created.name);
        const summary = `saved ${created.name} (${created.steps.length} steps)`;
        if (ctx.reply) await ctx.reply(summary);
        return { success: true, message: summary, data: created };
      }

      const maybeStepNum = parseInt(ctx.args[2], 10);
      const hasPosition = !isNaN(maybeStepNum) && ctx.args.length > 3;
      const stepText = hasPosition ? ctx.args.slice(3).join(' ') : ctx.args.slice(2).join(' ');

      if (!stepText.trim()) {
        const msg = 'usage: macro add-step <name> [step#] <step>';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      const parsed = MacroManager.parseMacroScript(name, stepText);
      if (parsed.steps.length === 0) {
        const msg = 'invalid step action';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      let insertedAt = macro.steps.length + 1;
      if (hasPosition) {
        const idx = Math.max(0, Math.min(macro.steps.length, maybeStepNum - 1));
        macro.steps.splice(idx, 0, ...parsed.steps);
        insertedAt = idx + 1;
      } else {
        macro.steps.push(...parsed.steps);
      }

      macro.description = `Custom macro with ${macro.steps.length} steps`;
      MacroManager.saveMacro(macro);
      registerDirectMacroCommand(macro.name);

      const summary = `added step #${insertedAt} to ${name} (${macro.steps.length} total steps)`;
      if (ctx.reply) await ctx.reply(summary);
      return { success: true, message: summary, data: macro };
    }

    // Remove a single step OR delete the whole macro:
    // macro remove-step <name> <step#> OR macro rm <name> <step#> OR macro delete <name> [step#]
    if (
      sub === 'remove-step' ||
      sub === 'removestep' ||
      sub === 'del-step' ||
      sub === 'delstep' ||
      sub === 'rm' ||
      sub === 'delete' ||
      sub === 'del' ||
      sub === 'remove'
    ) {
      const name = ctx.args[1]?.toLowerCase();
      const stepArg = ctx.args[2];
      if (!name) {
        const msg = 'usage: macro delete <name> [step#]';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      // If a step number is provided, delete only that step!
      if (stepArg !== undefined) {
        const stepNum = parseInt(stepArg, 10);
        const macro = MacroManager.getMacro(name);
        if (!macro) {
          const msg = 'macro not found';
          if (ctx.reply) await ctx.reply(msg);
          return { success: false, message: msg };
        }
        if (isNaN(stepNum) || stepNum < 1 || stepNum > macro.steps.length) {
          const msg = `invalid step #${stepArg} (${name} has ${macro.steps.length} steps)`;
          if (ctx.reply) await ctx.reply(msg);
          return { success: false, message: msg };
        }

        const removed = macro.steps.splice(stepNum - 1, 1)[0];
        macro.description = `Custom macro with ${macro.steps.length} steps`;
        MacroManager.saveMacro(macro);
        registerDirectMacroCommand(macro.name);

        const msg = `removed step #${stepNum} (${removed.label || removed.type}) from ${name} (${macro.steps.length} steps left)`;
        if (ctx.reply) await ctx.reply(msg);
        return { success: true, message: msg, data: macro };
      }

      const deleted = MacroManager.deleteMacro(name);
      const msg = deleted ? `deleted ${name}` : 'macro not found';
      if (ctx.reply) await ctx.reply(msg);
      return { success: deleted, message: msg };
    }

    if (sub === 'run' || sub === 'exec' || sub === 'start') {
      const name = ctx.args[1]?.toLowerCase();
      if (!name) {
        const msg = 'usage: macro run <name>';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      const macro = MacroManager.getMacro(name);
      if (!macro) {
        const msg = 'macro not found';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      return await MacroManager.executeMacro(macro, ctx);
    }

    if (sub === 'view' || sub === 'info' || sub === 'show') {
      const name = ctx.args[1]?.toLowerCase();
      const macro = name ? MacroManager.getMacro(name) : null;
      if (!macro) {
        const msg = 'macro not found';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      const details = macro.steps.map((s, idx) => `${idx + 1}. ${s.label || s.type}`).join('\n');
      if (ctx.reply) await ctx.reply(details);
      return { success: true, message: details, data: macro };
    }

    const help = 'usage: macro <list|create|edit|add-step|remove-step|view|delete>';
    if (ctx.reply) await ctx.reply(help);
    return { success: true, message: help };
  }
};

export const stopCommand: CommandDefinition = {
  name: 'stop',
  description: 'Stops all macros, farm, hold, sub, and auto-connect, and immediately disables all taps and releases screen touch.',
  usage: 'stop',

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { MacroManager } = await import('../macroManager');
    const { botManager } = await import('../botManager');
    const { stopSub, getRunningSubOption } = await import('./sub');
    const { stopHold } = await import('./index');
    const { stopFarm } = await import('./index');
    const adb = botManager.getAdbController();

    // 1. Signal stop to all running routines
    const stoppedAutoConnect = adb.stopAutoConnect();
    const subOpt = getRunningSubOption();
    const stoppedSub = stopSub();
    const stoppedHold = stopHold();
    const stoppedFarm = stopFarm();

    const runningName = MacroManager.getRunningMacro();
    if (runningName) {
      MacroManager.stopAll();
    }

    // 2. Immediately abort active ADB processes, kill input on device, and release touches
    await adb.stopAllTaps();

    // 3. Collect everything that was stopped
    const stoppedItems: string[] = [];
    if (runningName) {
      if (runningName.toLowerCase() === 'start') {
        stoppedItems.push('start (before step 1, 7, or 13)');
      } else {
        stoppedItems.push(runningName);
      }
    }
    if (stoppedHold || runningName === 'hold') stoppedItems.push('hold');
    if (stoppedFarm || runningName === 'farm') stoppedItems.push('farm');
    if (stoppedSub) stoppedItems.push(`sub ${subOpt}`);
    if (stoppedAutoConnect) stoppedItems.push('adb auto-connect');

    const stoppedFind = MacroManager.stopFind();
    if (stoppedFind) stoppedItems.push('find');

    let msg: string;
    if (stoppedItems.length > 0) {
      const unique = Array.from(new Set(stoppedItems));
      msg = `-# 🛑 stopped ${unique.join(', ')} & disabled all taps`;
    } else {
      msg = `-# 🛑 disabled all taps & released touch (nothing was running)`;
    }

    ctx.log(msg, 'info');
    if (ctx.reply) await ctx.reply(msg);
    return { success: true, message: msg };
  }
};

export const disableTapsCommand: CommandDefinition = {
  name: 'disable-taps',
  description: 'Immediately disables all active taps, stops any running hold/swipe on device, and clears stuck touch state.',
  usage: 'disable-taps',
  aliases: ['disabletaps', 'stoptaps', 'releasetouch', 'untap', 'fixtouch', 'cleartaps'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const { stopHold, stopFarm } = await import('./index');
    const { stopSub } = await import('./sub');
    const { MacroManager } = await import('../macroManager');

    stopHold();
    stopFarm();
    stopSub();
    MacroManager.stopAll();
    MacroManager.stopFind();

    const adb = botManager.getAdbController();
    await adb.stopAllTaps();

    const msg = '-# 🛑 all taps disabled on device & screen touches released';
    ctx.log(msg, 'info');
    if (ctx.reply) await ctx.reply(msg);
    return { success: true, message: msg };
  }
};

export const imagesCommand: CommandDefinition = {
  name: 'images',
  description: 'Sends all saved images and their filenames from the sdcard/autoclick folder to Discord.',
  usage: 'images [delete <filename>]',
  aliases: ['files', 'saved', 'pics', 'list-images'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const webhook = botManager.getWebhookService();
    const fs = await import('fs');
    const path = await import('path');

    const sub = ctx.args[0]?.toLowerCase();
    if (sub === 'delete' || sub === 'del' || sub === 'rm' || sub === 'remove') {
      const targetName = ctx.args[1];
      if (!targetName) {
        const msg = 'usage: images delete <filename>';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      const clean = path.basename(targetName.trim());
      const resolved = StoragePaths.resolveImage(clean);

      if (resolved && fs.existsSync(resolved)) {
        await fs.promises.unlink(resolved);
        const msg = `deleted \`${path.basename(resolved)}\` from \`${path.dirname(resolved)}\``;
        if (ctx.reply) await ctx.reply(msg);
        return { success: true, message: msg };
      }

      const msg = `file "${clean}" not found in \`sdcard/autoclick/images/\``;
      if (ctx.reply) await ctx.reply(msg);
      return { success: false, message: msg };
    }

    const allImages = StoragePaths.getAllImages();

    if (allImages.length === 0) {
      const msg = `no saved images in \`${StoragePaths.getImagesDir()}\``;
      if (ctx.reply) await ctx.reply(msg);
      return { success: true, message: msg };
    }

    if (webhook.isConfigured()) {
      for (const img of allImages) {
        try {
          const buf = await fs.promises.readFile(img.fullPath);
          await webhook.send({
            content: `\`${img.name}\` *(folder: ${img.folder})*`,
            fileBuffer: buf,
            fileName: img.name
          });
        } catch {
          // ignore unreadable file
        }
      }
    } else if (ctx.reply) {
      const listLines = allImages.map((img) => `• \`${img.name}\` (${img.folder}/)`);
      await ctx.reply(`📁 **Saved Images** (${allImages.length}):\n${listLines.join('\n')}`);
    }

    return {
      success: true,
      message: `found ${allImages.length} images`,
      data: { files: allImages.map((i) => i.name) }
    };
  }
};

export const pingCommand: CommandDefinition = {
  name: 'ping',
  description: 'Checks Discord gateway latency and responsiveness.',
  usage: 'ping',
  aliases: ['p', 'pong', 'latency'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const discord = botManager.getDiscordBot();
    const client = discord.getClient();

    const wsPing = client && client.ws && client.ws.ping >= 0 ? Math.round(client.ws.ping) : -1;
    const msgTime = ctx.discordMessage?.createdTimestamp;
    const now = Date.now();
    const roundtrip = msgTime ? Math.max(0, now - msgTime) : 0;

    const parts = [
      '-# 🏓 pong!',
      roundtrip > 0 ? `-# roundtrip: ${roundtrip}ms` : '',
      wsPing >= 0 ? `-# websocket: ${wsPing}ms` : ''
    ].filter(Boolean).join('\n');

    if (ctx.reply) {
      await ctx.reply(parts);
    }

    return {
      success: true,
      message: parts,
      data: { roundtrip, wsPing }
    };
  }
};

export const liveCommand: CommandDefinition = {
  name: 'live',
  description: 'Stops all local scripts and starts on-demand Live Browser Remote Control on port 4444 (local, net, or all).',
  usage: 'live <local|net|all|stop>',
  aliases: ['tunnel', 'remote', 'stoplive'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { LiveController, LIVE_PORT } = await import('../liveController');
    const sub = (ctx.commandName === 'stoplive' ? 'stop' : ctx.args[0] || '').toLowerCase().trim();

    if (sub === 'stop' || sub === 'off' || sub === 'close') {
      const status = await LiveController.stopLiveTunnel();
      const msg = '-# live stoped';
      ctx.log(msg, 'info');
      if (ctx.reply) await ctx.reply(msg);
      return { success: true, message: msg, data: status };
    }

    // If no argument or 'local', default to local. Allow 'net', 'all', 'stop'
    const mode: 'local' | 'net' | 'all' = sub === 'net' ? 'net' : sub === 'all' ? 'all' : 'local';
    const status = await LiveController.startLiveTunnel(LIVE_PORT, (m) => ctx.log(m, 'info'), mode);

    const localLink = status.localUrl || `http://127.0.0.1:${LIVE_PORT}`;
    const cleanIpPort = localLink.replace(/^https?:\/\//, '');
    const lines: string[] = [];

    if (mode === 'local') {
      lines.push('-# live local started');
      if (localLink) lines.push(`[${cleanIpPort}](${localLink})`);
    } else if (mode === 'net') {
      lines.push('-# live net started');
      if (status.publicUrl) {
        const cleanNet = status.publicUrl.replace(/^https?:\/\//, '');
        lines.push(`[${cleanNet}](${status.publicUrl})`);
      } else if (status.error) {
        lines.push(`-# error: ${status.error}`);
      }
    } else {
      lines.push('-# live all started');
      if (localLink) lines.push(`[${cleanIpPort}](${localLink})`);
      if (status.publicUrl) {
        const cleanNet = status.publicUrl.replace(/^https?:\/\//, '');
        lines.push(`[${cleanNet}](${status.publicUrl})`);
      }
    }

    const msg = lines.join('\n');
    ctx.log(msg, 'info');
    if (ctx.reply) await ctx.reply(msg);
    return { success: true, message: msg, data: status };
  }
};

const COMMAND_MANUALS: Record<string, string> = {
  sub: [
    '**sub** — Automated 12-step Sonobuoy sequence (repeats every 60s until `stop`)',
    'usage:',
    '• `sub normal` — uses `Armada Detection Sonobuoy (Normal)`',
    '• `sub red` — uses `Armada Detection Sonobuoy (Special)` (red)',
    '• `sub gold` — uses `Armada Detection Sonobuoy (Special)` (gold)',
    '• `sub stop` (or `stop`) — stops the running `sub` loop'
  ].join('\n'),

  live: [
    '**live** — Stop all local scripts & start on-demand Live Browser Control on port 4444',
    'usage:',
    '• `live local` — starts Live Control for **Local Wi-Fi only** (`http://<phone-ip>:4444`)',
    '• `live net` — starts Live Control over **Internet only** (`https://xxxx.trycloudflare.com` with fast compressed images)',
    '• `live all` — starts Live Control for **both** Local Wi-Fi and Internet',
    '• `live stop` — completely shuts down port `4444` and closes the Cloudflare internet tunnel'
  ].join('\n'),

  texts: [
    '**texts** — Extracts all visible texts on screen (with X/Y coordinates) via OCR and sends them to Discord',
    'usage:',
    '`texts` — Scans the entire screen and lists all texts + coordinates',
    '`texts 700-960 1300-1360` — Scans only a specific X/Y area'
  ].join('\n'),

  fixac: [
    '**fixac** — Automated repair sequence with `csg.png` (7 steps standalone, 12 steps during `start` cycle)',
    'usage: `fixac`',
    '1. Taps random point in X=45–99, Y=2010–2064 (waits 0.5s)',
    '2. Taps random point in X=50–99, Y=1875–1924 (waits 0.5s)',
    '3. Taps 50x50 px center of screen (waits 0.5s)',
    '4. Finds `csg.png` on screen & taps it (waits 0.5s)',
    '5. Taps random point in X=311–774, Y=2192–2281 (waits 0.5s)',
    '6. Taps random point in X=362–720, Y=1874–1963 (waits 0.5s)',
    '7. Taps random point in X=33–122, Y=91–170',
    '*(If running during `start` cycle)*:',
    '8. Taps random point in X=642–691, Y=2075–2124 (waits 0.5s)',
    '9. Taps random point in X=127–269, Y=801–886 (waits 0.5s)',
    '10. Taps random point in X=256–757, Y=935–1063 (waits 0.5s)',
    '11. Taps random point in X=577–890, Y=1721–1810 (waits 0.5s)',
    '12. Taps 10x10 px center of screen (waits 0.5s)'
  ].join('\n'),

  ai: [
    '**ai** — Gemini 3.8 Flash Vision Self-Learning Prompt Memory',
    'usage:',
    '• `ai` — scans current screen for unexpected dialogs/popups with Gemini Flash, clicks to resolve, and saves template to sdcard',
    '• `ai list` — lists all learned prompts stored on sdcard and how many times they were reused offline',
    '• `ai forget <id>` — deletes a prompt from learned memory on sdcard',
    '• `ai test` — analyzes screen without tapping'
  ].join('\n'),

  move: [
    '**move** — Aircraft Carrier (AC) movement automation',
    'usage: `move`',
    '1. Checks 20-94 455-529 for `fleet.png` (if no match: clicks 939-1062 2175-2302; if matched: ignores click)',
    '2. Clicks 644-688 2075-2119',
    '3. Clicks 278-685 951-1047',
    '4. Clicks 595-880 1723-1807',
    '5. Clicks fixed location 230 1520',
    '6. Searches for `acd1.png` and clicks it; if prompt "Yes" is found: clicks 158-507 1704-1796, 932-1056 2175-2305, swipes down, clicks 299-403 731-866, checks shiprepair.png, swipes left for "Elizabeth", clicks acre.png, clicks "Repair" in 376-717 1865-1971, and clicks 939-1062 2175-2302',
    '7. Verifies 576-849 1407-1499 with `acd2.png` and clicks it',
    '8. Verifies 597-970 2181-2299 with `acd3.png` and clicks it',
    '9. Waits 2 seconds',
    '10. Checks 8-143 1832-1966 for timer; if exists sends "ac is moving", polls every 10s in background until timer disappears, then updates message to "arrived"'
  ].join('\n'),

  ping: [
    '**ping** — Checks Discord gateway latency and responsiveness',
    'usage: `ping`',
    '• Displays roundtrip latency (message response time in ms)',
    '• Displays WebSocket gateway heartbeat latency in ms'
  ].join('\n'),

  find: [
    '**find** — Automated pfp search & capture sequence',
    'usage: `find`',
    '1. Taps random point in X=227–766, Y=2326–2387 (waits 2s)',
    '2. Taps random point in X=578–763, Y=230–327 (waits 3s)',
    '3. Captures screenshot & searches for `pfp.jpg` inside X=79–220, Y=523–1721',
    '4. Taps inside matched pfp (waits 3.5s)',
    '5. Taps random point in X=255–342, Y=2116–2156 (waits 3s)',
    '6. Captures screenshot, crops 150×150 center, and updates the Discord webhook message'
  ].join('\n'),

  farm: [
    '**farm** — Farming loop',
    'usage: `farm [turns]`',
    '1. Taps X=530–549, Y=1190–1209',
    '2. Searches `rssatk.png` in X=727–796, Y=1227–1301',
    '3. Searches `as1.png` in X=230–309, Y=1591–1670',
    '4. Waits 6 seconds, then repeats.',
    '• Optional: Provide `<turns>` to stop automatically after that many iterations.'
  ].join('\n'),

  macro: [
    '**macro** — Create & edit custom commands that run directly by name',
    'subcommands:',
    '• `macro create <name> <steps>` — saves command `<name>` (call it by sending `<name>` in Discord)',
    '• `macro view <name>` — shows numbered steps inside `<name>`',
    '• `macro edit <name> <step#> <newStep>` — replaces ONLY step `<step#>` (e.g. `macro edit start 3 wait 4000`)',
    '• `macro add-step <name> <newStep>` — adds a new step to the end (e.g. `macro add-step start crop 150`)',
    '• `macro insert <name> <step#> <newStep>` — inserts a new step at `<step#>` (e.g. `macro insert start 2 wait 2000`)',
    '• `macro rm <name> <step#>` — removes ONLY step `<step#>` (e.g. `macro rm start 4`)',
    '• `macro delete <name>` — deletes the entire macro `<name>`',
    '• `macro list` — lists all saved custom commands',
    'step actions you can use:',
    '• `tap <x> <y>` — tap exact point (e.g. `tap 500 1000`)',
    '• `hold <x> <y> [duration]` — hold / long press point (e.g. `hold 500 1000 2s`)',
    '• `tap <minX>-<maxX> <minY>-<maxY>` — random tap in box (e.g. `tap 227-766 2326-2387`)',
    '• `hold <minX>-<maxX> <minY>-<maxY> [duration]` — hold random point in box (e.g. `hold 200-400 500-600 1500`)',
    '• `wait <ms or Ns>` — wait time (e.g. `wait 2000` or `wait 3s`)',
    '• `search <img>` — find image from `autoclick/` on screen & tap it (e.g. `search btn.jpg`)',
    '• `search <img> hold <duration>` — find image on screen & hold it (e.g. `search btn.jpg hold 2000`)',
    '• `search <img> <minX>-<maxX> <minY>-<maxY>` — find image inside box & tap (e.g. `search pfp.jpg 79-220 523-1721`)',
    '• `crop <size>` — screenshot + center crop `<size>x<size>` + send to webhook (e.g. `crop 150`)',
    '• `loop` — repeats the macro from step 1 in an infinite loop until you send `stop`',
    'example:',
    '`macro create start`',
    '`1. tap 227-766 2326-2387`',
    '`2. wait 2000`',
    '`3. search pfp.jpg 79-220 523-1721`',
    '`4. wait 3000`',
    '`5. crop 150`',
    'then just send `start` in Discord!'
  ].join('\n'),

  tap: [
    '**tap** — Tap coordinates on screen via ADB (with optional hold duration)',
    'usage:',
    '• `tap <x> <y> [holdMs]` — taps coordinate (e.g. `tap 540 1200` or `tap 540 1200 2000` to hold)',
    '• `tap <minX>-<maxX> <minY>-<maxY> [holdMs]` — taps random point inside box'
  ].join('\n'),

  hold: [
    '**hold** (or `press`, `longpress`) — Hold coordinates on screen for specified minutes',
    'usage:',
    '• `hold silver <minutes>` — holds silver area `677-955 1946-2099` (e.g. `hold silver 10`)',
    '• `hold <xrange> <yrange> <minutes>` — holds random point in range (e.g. `hold 123-345 56-738 5`)',
    '• `hold <x> <y> <minutes>` — holds exact coordinate point'
  ].join('\n'),

  screenshot: [
    '**screenshot** — Capture screen, crop area & optionally save to sdcard',
    'usage:',
    '• `screenshot` — captures full Android screen and sends to webhook',
    '• `screenshot <minX>-<maxX> <minY>-<maxY>` — crops only that X/Y area and sends it without saving (e.g. `screenshot 79-220 523-1721`)',
    '• `screenshot <minX>-<maxX> <minY>-<maxY> save <name>` — crops area, permanently saves to `/sdcard/autoclick/<name>.png`, and sends the cropped image & name to Discord (e.g. `screenshot 200-400 800-900 save btn`)',
    '• `screenshot crop` — captures screen and crops 150×150 center'
  ].join('\n'),

  cleanup: [
    '**cleanup** — Manually trigger an automatic channel purge.',
    'Removes all messages in the channel except the main dashboard message.',
    'Includes a 5-second delay between deletions to stay safe from Discord rate limits.'
  ].join('\n'),

  connect: [
    '**connect** — Connect to Wireless ADB',
    'usage: `connect <port>` or `connect <ip:port>`',
    'example: `connect 42351` (connects to 127.0.0.1:42351)'
  ].join('\n'),

  pair: [
    '**pair** — Pair Wireless Debugging with pairing code',
    'usage: `pair <port> <code>` or `pair <ip:port> <code>`',
    'example: `pair 39123 482910`'
  ].join('\n'),

  devices: [
    '**devices** — List connected ADB devices',
    'usage: `devices`',
    'shows each connected device serial and status (`device`, `offline`, etc.)'
  ].join('\n'),

  status: [
    '**status** — Show bot & ADB status',
    'usage: `status`',
    'displays ADB status, active device, match threshold, auto-update status, and uptime'
  ].join('\n'),

  buttons: [
    '**buttons** (or `panel`) — Interactive Discord control buttons',
    'usage: `buttons` or `panel`',
    'displays clickable Discord buttons for Stop, Start, Fixac, Status, and Screenshot'
  ].join('\n'),

  panel: [
    '**panel** (or `buttons`) — Interactive Discord control buttons',
    'usage: `panel` or `buttons`',
    'displays clickable Discord buttons for Stop, Start, Fixac, Status, and Screenshot'
  ].join('\n'),

  update: [
    '**update** — Pull latest GitHub update & restart',
    'usage: `update`',
    'fetches latest commit from GitHub, installs dependencies if needed, and restarts bot'
  ].join('\n'),

  'check-update': [
    '**check-update** — Check for GitHub updates',
    'usage: `check-update`',
    'compares local commit hash against remote GitHub branch without restarting'
  ].join('\n'),

  restart: [
    '**restart** — Restart bot process',
    'usage: `restart`'
  ].join('\n'),

  'set-token': [
    '**set-token** — Save GitHub token or repo',
    'usage:',
    '• `set-token <ghp_token>` — saves GitHub PAT for private repo updates',
    '• `set-token repo <owner/repo>` — sets GitHub repository',
    '• `set-token clear` — removes saved GitHub token'
  ].join('\n'),

  images: [
    '**images** — Send all saved images & names from `/sdcard/autoclick/`',
    'usage:',
    '• `images` — sends every image in `/sdcard/autoclick/` along with its filename to Discord',
    '• `images delete <name>` — deletes a saved image from `/sdcard/autoclick/`'
  ].join('\n'),

  help: [
    '**help** — View manual or specific command help',
    'usage:',
    '• `help` — shows full command manual overview',
    '• `help <command>` — shows detailed guide for one command (e.g. `help macro`, `help find`, `help tap`)'
  ].join('\n')
};

export const helpCommand: CommandDefinition = {
  name: 'help',
  description: 'Shows the bot manual or detailed help for a specific command.',
  usage: 'help [command]',

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { MacroManager } = await import('../macroManager');
    MacroManager.init();

    const target = ctx.args[0]?.toLowerCase().trim();

    if (target) {
      if (COMMAND_MANUALS[target]) {
        const msg = COMMAND_MANUALS[target];
        if (ctx.reply) await ctx.reply(msg);
        return { success: true, message: msg };
      }

      // Check if it's a user-created custom macro (e.g. "help start")
      const customMacro = MacroManager.getMacro(target);
      if (customMacro) {
        const stepsList = customMacro.steps
          .map((s, idx) => `${idx + 1}. ${s.label || s.type}`)
          .join('\n');
        const msg = [
          `**${customMacro.name}** — Custom macro command (${customMacro.steps.length} steps)`,
          `usage: send \`${customMacro.name}\` in Discord`,
          'steps:',
          stepsList,
          `manage: \`macro view ${customMacro.name}\` | \`macro delete ${customMacro.name}\``
        ].join('\n');
        if (ctx.reply) await ctx.reply(msg);
        return { success: true, message: msg };
      }

      const notFoundMsg = `unknown command "${target}". send \`help\` to see all commands.`;
      if (ctx.reply) await ctx.reply(notFoundMsg);
      return { success: false, message: notFoundMsg };
    }

    const customMacros = MacroManager.getMacros();
    const customList =
      customMacros.length > 0
        ? customMacros.map((m) => `\`${m.name}\` (${m.steps.length} steps)`).join(', ')
        : 'none yet (use `macro create <name> <steps>`)';

    const manualOverview = [
      '**bot manual** — send `help <command>` for detailed usage (e.g. `help macro`, `help ping`, `help find`)',
      '• `ai` — Gemini Vision unexpected prompt learner (`help ai`)',
      '• `find` — run automated pfp search, tap & 150×150 center crop sequence',
      '• `farm [turns]` — farming loop: tap, search rssatk, search as1, wait',
      '• `ping` — check Discord gateway latency and responsiveness (`help ping`)',
      '• `macro` — create & manage custom multi-step commands (`help macro`)',
      '• `tap` — tap exact `X Y` or random `minX-maxX minY-maxY` (`help tap`)',
      '• `hold` — hold / long-press coordinates or random box for duration (`help hold`)',
      '• `screenshot` — capture full screen, crop `X Y` area, or save to sdcard (`help screenshot`)',
      '• `images` — send all saved images & names from `/sdcard/autoclick/` (`help images`)',
      '• `connect` / `pair` / `devices` — wireless ADB connection tools (`help connect`)',
      '• `clear` / `purge` — delete recent messages from the Discord channel',
      '• `cleanup` — auto-delete all channel messages with 5s delay until empty (`help cleanup`)',
      '• `status` — check ADB device & bot status',
      '• `update` / `check-update` / `restart` — GitHub auto-updater & process control',
      `• custom commands: ${customList}`
    ].join('\n');

    if (ctx.reply) await ctx.reply(manualOverview);
    return { success: true, message: manualOverview };
  }
};

export { clearCommand } from './clear';

let farmRunning = false;
let farmStopRequested = false;

export function isFarmRunning(): boolean {
  return farmRunning;
}

export function stopFarm(): boolean {
  if (!farmRunning) return false;
  farmStopRequested = true;
  return true;
}

export const farmCommand: CommandDefinition = {
  name: 'farm',
  description: 'Farming loop: tap resource tile, search rssatk/asbtn, search as1, wait.',
  usage: 'farm [turns] [xrange yrange] (e.g. farm, form, farm 20, farm 20 465-602 1109-1223)',
  aliases: ['form', 'farming'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const { TemplateMatcher } = await import('../matcher');
    const { MacroManager } = await import('../macroManager');
    const { StoragePaths } = await import('../storagePaths');
    const adb = botManager.getAdbController();
    const config = botManager.getConfig();

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    const resolveFarmingImage = (name: string): string | null => {
      // 1. Check StoragePaths resolveImage
      const direct = StoragePaths.resolveImage(name);
      if (direct && fs.existsSync(direct)) return direct;

      const clean = name.replace(/\.(png|jpe?g|webp)$/i, '');
      for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
        const cand = StoragePaths.resolveImage(`${clean}${ext}`);
        if (cand && fs.existsSync(cand)) return cand;
      }

      // 2. Check candidate directories directly
      const homeDir = process.env.HOME || os.homedir() || '';
      const candidateDirs = [
        StoragePaths.getImagesDir(),
        StoragePaths.getBaseDir(),
        path.join(StoragePaths.getBaseDir(), 'images'),
        path.resolve(homeDir, 'storage/shared/autoclick/images'),
        path.resolve(homeDir, 'storage/shared/autoclick'),
        path.join(os.homedir(), 'storage', 'shared', 'autoclick', 'images'),
        path.join(os.homedir(), 'storage', 'shared', 'autoclick'),
        '/sdcard/autoclick/images',
        '/sdcard/autoclick',
        '/storage/emulated/0/autoclick/images',
        '/storage/emulated/0/autoclick',
        path.resolve(process.cwd(), 'data/autoclick/images'),
        path.resolve(process.cwd(), 'data/autoclick'),
        process.cwd()
      ];

      for (const dir of candidateDirs) {
        if (!fs.existsSync(dir)) continue;
        for (const variant of [name, `${clean}.png`, `${clean}.jpg`, `${clean}.jpeg`]) {
          const candidate = path.join(dir, variant);
          if (fs.existsSync(candidate)) return candidate;
        }
      }

      return null;
    };

    // Supports rssatk.png or asbtn.png as the attack/gather trigger
    const rssatkPath = resolveFarmingImage('rssatk') || resolveFarmingImage('asbtn');
    const as1Path = resolveFarmingImage('as1');

    if (!rssatkPath || !as1Path) {
      const missingList: string[] = [];
      if (!rssatkPath) missingList.push('rssatk.png (or asbtn.png)');
      if (!as1Path) missingList.push('as1.png');
      const err = `Image file not found: ${missingList.join(', ')} — please save to /sdcard/autoclick/images/ on your device`;
      ctx.log(err, 'error');
      if (ctx.reply) await ctx.reply(`-# ❌ ${err}`);
      return { success: false, message: err };
    }

    let maxIterations = Infinity;
    let tileMinX = 465, tileMaxX = 602, tileMinY = 1109, tileMaxY = 1223;

    if (ctx.args && ctx.args.length > 0) {
      const firstArg = ctx.args[0].trim();
      if (/^\d+$/.test(firstArg)) {
        maxIterations = parseInt(firstArg, 10);
        if (ctx.args.length >= 3 && ctx.args[1].includes('-') && ctx.args[2].includes('-')) {
          const [x1, x2] = ctx.args[1].split('-').map(Number);
          const [y1, y2] = ctx.args[2].split('-').map(Number);
          if (!isNaN(x1) && !isNaN(x2)) { tileMinX = Math.min(x1, x2); tileMaxX = Math.max(x1, x2); }
          if (!isNaN(y1) && !isNaN(y2)) { tileMinY = Math.min(y1, y2); tileMaxY = Math.max(y1, y2); }
        }
      } else if (firstArg.includes('-') && ctx.args.length >= 2 && ctx.args[1].includes('-')) {
        const [x1, x2] = firstArg.split('-').map(Number);
        const [y1, y2] = ctx.args[1].split('-').map(Number);
        if (!isNaN(x1) && !isNaN(x2)) { tileMinX = Math.min(x1, x2); tileMaxX = Math.max(x1, x2); }
        if (!isNaN(y1) && !isNaN(y2)) { tileMinY = Math.min(y1, y2); tileMaxY = Math.max(y1, y2); }
        if (ctx.args.length >= 3 && /^\d+$/.test(ctx.args[2].trim())) {
          maxIterations = parseInt(ctx.args[2].trim(), 10);
        }
      }
    }

    farmRunning = true;
    farmStopRequested = false;
    MacroManager.setRunningMacro('farm');

    const limitDesc = maxIterations === Infinity ? 'unlimited' : `${maxIterations} turns`;
    ctx.log(`🚜 Starting farming loop... (limit: ${limitDesc}, tile: X=[${tileMinX}..${tileMaxX}] Y=[${tileMinY}..${tileMaxY}], send "stop" to halt)`, 'info');
    if (ctx.reply) await ctx.reply(`-# 🚜 Farming started (limit: ${limitDesc})`);

    const interruptibleWait = async (totalMs: number): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < totalMs) {
        if (farmStopRequested || MacroManager.getRunningMacro() !== 'farm') {
          return false;
        }
        await sleep(Math.min(100, totalMs - (Date.now() - start)));
      }
      return !farmStopRequested && MacroManager.getRunningMacro() === 'farm';
    };

    const thresh = Math.min(config.matchThreshold || 0.72, 0.75);
    const multiScales = [0.85, 0.92, 1.0, 1.08, 1.15];

    try {
      let iterations = 0;
      while (!farmStopRequested && MacroManager.getRunningMacro() === 'farm') {
        if (maxIterations !== Infinity && iterations >= maxIterations) {
          ctx.log('🚜 Farming limit reached.', 'info');
          break;
        }
        iterations++;
        ctx.log(`🚜 Farming iteration ${iterations}/${maxIterations === Infinity ? '∞' : maxIterations}`, 'info');

        // 1. Tap resource tile
        await adb.tapRandomRange(tileMinX, tileMaxX, tileMinY, tileMaxY);
        if (!(await interruptibleWait(850))) break;

        // 2. Search attack / gather button (rssatk or asbtn)
        let foundRssatk = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (farmStopRequested || MacroManager.getRunningMacro() !== 'farm') break;

          const rawScreen1 = await adb.screencapRaw().catch(() => null);
          if (!rawScreen1) {
            await interruptibleWait(300);
            continue;
          }

          // Search primary region first (650-900, 1050-1350)
          let matchRssatk = await TemplateMatcher.matchRaw(rawScreen1, rssatkPath, {
            scales: multiScales,
            threshold: thresh,
            region: { minX: 650, maxX: 900, minY: 1050, maxY: 1350 }
          }).catch(() => null);

          // Fallback to full screen if not detected in region
          if (!matchRssatk || !matchRssatk.found) {
            matchRssatk = await TemplateMatcher.matchRaw(rawScreen1, rssatkPath, {
              scales: multiScales,
              threshold: thresh
            }).catch(() => null);
          }

          if (matchRssatk && matchRssatk.found) {
            ctx.log(`🚜 Found attack/gather button, clicking (${matchRssatk.targetPoint.x}, ${matchRssatk.targetPoint.y})`, 'info');
            await adb.tap(matchRssatk.targetPoint.x, matchRssatk.targetPoint.y);
            foundRssatk = true;
            break;
          }

          await interruptibleWait(350);
        }

        if (!foundRssatk) {
          ctx.log('🚜 Attack/gather button not detected on screen, retrying next loop', 'warn');
          if (!(await interruptibleWait(2000))) break;
          continue;
        }

        // Wait for troop march window to open
        if (!(await interruptibleWait(800))) break;

        // 3. Search as1 march button
        let foundAs1 = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (farmStopRequested || MacroManager.getRunningMacro() !== 'farm') break;

          const rawScreen2 = await adb.screencapRaw().catch(() => null);
          if (!rawScreen2) {
            await interruptibleWait(300);
            continue;
          }

          // Search primary region (180-360, 1550-1780)
          let matchAs1 = await TemplateMatcher.matchRaw(rawScreen2, as1Path, {
            scales: multiScales,
            threshold: thresh,
            region: { minX: 180, maxX: 360, minY: 1550, maxY: 1780 }
          }).catch(() => null);

          // Fallback to full screen if not found in region
          if (!matchAs1 || !matchAs1.found) {
            matchAs1 = await TemplateMatcher.matchRaw(rawScreen2, as1Path, {
              scales: multiScales,
              threshold: thresh
            }).catch(() => null);
          }

          if (matchAs1 && matchAs1.found) {
            ctx.log(`🚜 Found as1 march button, clicking (${matchAs1.targetPoint.x}, ${matchAs1.targetPoint.y})`, 'info');
            await adb.tap(matchAs1.targetPoint.x, matchAs1.targetPoint.y);
            foundAs1 = true;
            break;
          }

          await interruptibleWait(350);
        }

        if (!foundAs1) {
          ctx.log('🚜 as1 march button not detected on screen', 'warn');
        }

        // 4. Wait 6 seconds before next farming turn (instantly stops if stop sent)
        if (!(await interruptibleWait(6000))) break;
      }
    } finally {
      farmRunning = false;
      if (MacroManager.getRunningMacro() === 'farm') {
        MacroManager.setRunningMacro(null);
      }
    }

    ctx.log('🚜 Farming stopped.', 'info');
    if (ctx.reply) await ctx.reply('-# 🚜 Farming stopped.');
    return { success: true, message: 'Farming stopped' };
  }
};

export const apkCommand: CommandDefinition = {
  name: 'apk',
  description: 'Provides direct download link and setup instructions for Wi-Fi Debug Keeper APK.',
  usage: 'apk',
  aliases: ['wifidebug', 'wifidbg', 'keeper'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const text = [
      '-# 📲 **Wi-Fi Debug Keeper (.apk)**',
      '-# Automatically enables Wireless Debugging and port 5555 on reboot or Wi-Fi reconnect.',
      '-# 📥 **Direct Download**: http://127.0.0.1:3000/api/download/wifi-debug-keeper.apk',
      '-# ⚡ **1-Time Permission Grant** (run once in Termux or ADB):',
      '```bash',
      'adb shell pm grant com.autoclick.wifidebug android.permission.WRITE_SECURE_SETTINGS',
      '```',
      '-# ✅ Once granted, `run.sh` will auto-trigger the APK and connect on startup!'
    ].join('\n');

    ctx.log('Sent APK download link and instructions', 'info');
    if (ctx.reply) await ctx.reply(text);
    return { success: true, message: 'APK download information sent' };
  }
};

