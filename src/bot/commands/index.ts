import { CommandDefinition, CommandContext, CommandResult } from '../types';

export const tapCommand: CommandDefinition = {
  name: 'tap',
  description: 'Taps exact coordinate or random range on Android device.',
  usage: 'tap <x> <y>  OR  tap <xMin-xMax> <yMin-yMax>',
  aliases: ['click', 'input-tap'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const adb = botManager.getAdbController();

    if (ctx.args.length < 2) {
      const msg = 'usage: tap <x> <y>';
      if (ctx.reply) await ctx.reply(msg);
      return { success: false, message: msg };
    }

    const argX = ctx.args[0];
    const argY = ctx.args[1];

    let result;
    if (argX.includes('-') || argY.includes('-')) {
      const [minX, maxX] = argX.split('-').map(Number);
      const [minY, maxY] = argY.split('-').map(Number);
      if (isNaN(minX) || isNaN(maxX) || isNaN(minY) || isNaN(maxY)) {
        const msg = 'invalid range';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }
      result = await adb.tapRandomRange(minX, maxX, minY, maxY);
    } else {
      const x = parseInt(argX, 10);
      const y = parseInt(argY, 10);
      if (isNaN(x) || isNaN(y)) {
        const msg = 'invalid coordinates';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }
      result = await adb.tap(x, y);
    }

    const output = `tapped (${result.x}, ${result.y})`;
    ctx.log(output, 'info');
    if (ctx.reply) await ctx.reply(output);
    return { success: true, message: output, data: result };
  }
};

export const screenshotCommand: CommandDefinition = {
  name: 'screenshot',
  description: 'Takes a screenshot (full, center-crop, or X/Y range) and optionally saves it to sdcard/autoclick.',
  usage: 'screenshot [minX-maxX minY-maxY] [save [filename]]',
  aliases: ['screenshoot', 'screencap', 'screen', 'snap', 'ss', 'sc'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const adb = botManager.getAdbController();
    const webhook = botManager.getWebhookService();
    const { TemplateMatcher } = await import('../matcher');
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    ctx.log('📸 Capturing screenshot...', 'info');
    const screenBuffer = await adb.screencap();

    let finalBuffer = screenBuffer;
    let labelText = '**screenshot**';
    let isRegionCrop = false;

    // Robust parsing of screenshot cropping arguments:
    // Supports:
    // 1) "screenshot 79-220 523-1721" (ranges)
    // 2) "screenshot 79 220 523 1721" (4 coordinate values)
    // 3) "screenshot 500 1000" (center around X, Y with 150x150 box)
    // 4) "screenshot crop [size]" or "screenshot center-crop"
    let region: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
    let isCenterCrop = false;
    let centerCropSize = 150;

    const rawArgsJoined = ctx.args
      .join(' ')
      .replace(/[–—]/g, '-')
      .replace(/\b[xy]\s*:\s*/gi, '')
      .replace(/,/g, ' ');

    if (/\b(?:center-?crop|crop)\b/i.test(rawArgsJoined)) {
      const matchSize = rawArgsJoined.match(/\b(?:crop|center-?crop)\s+(\d+)\b/i);
      if (matchSize) centerCropSize = parseInt(matchSize[1], 10) || 150;
      isCenterCrop = true;
    }

    // Check for range patterns: e.g. "79-220" and "523-1721"
    const rangeRegex = /(\d+)\s*-\s*(\d+)/g;
    const ranges: Array<{ min: number; max: number }> = [];
    let rMatch: RegExpExecArray | null;
    while ((rMatch = rangeRegex.exec(rawArgsJoined)) !== null) {
      ranges.push({ min: Number(rMatch[1]), max: Number(rMatch[2]) });
    }

    if (ranges.length >= 2) {
      region = {
        minX: Math.min(ranges[0].min, ranges[0].max),
        maxX: Math.max(ranges[0].min, ranges[0].max),
        minY: Math.min(ranges[1].min, ranges[1].max),
        maxY: Math.max(ranges[1].min, ranges[1].max)
      };
    } else if (ranges.length === 1 && !isCenterCrop) {
      region = {
        minX: Math.min(ranges[0].min, ranges[0].max),
        maxX: Math.max(ranges[0].min, ranges[0].max),
        minY: 0,
        maxY: 2400
      };
    } else if (!isCenterCrop) {
      // Check for standalone numbers (ignore save argument words)
      const nonSaveArgs = rawArgsJoined
        .replace(/\bsave\s+[^\s]+/i, '')
        .replace(/\bsave\b/i, '')
        .replace(/\b(?:center-?crop|crop)\b/i, '');
      const numbers = (nonSaveArgs.match(/\d+/g) || []).map(Number);

      if (numbers.length >= 4) {
        region = {
          minX: Math.min(numbers[0], numbers[1]),
          maxX: Math.max(numbers[0], numbers[1]),
          minY: Math.min(numbers[2], numbers[3]),
          maxY: Math.max(numbers[2], numbers[3])
        };
      } else if (numbers.length === 2) {
        // "screenshot X Y" -> crop 150x150 box centered on (X, Y)
        const cx = numbers[0];
        const cy = numbers[1];
        const half = 75;
        region = {
          minX: Math.max(0, cx - half),
          maxX: cx + half,
          minY: Math.max(0, cy - half),
          maxY: cy + half
        };
      } else if (numbers.length === 3) {
        // "screenshot X Y size"
        const cx = numbers[0];
        const cy = numbers[1];
        const half = Math.floor(numbers[2] / 2);
        region = {
          minX: Math.max(0, cx - half),
          maxX: cx + half,
          minY: Math.max(0, cy - half),
          maxY: cy + half
        };
      }
    }

    if (region) {
      const cropped = await TemplateMatcher.cropRegion(screenBuffer, region.minX, region.maxX, region.minY, region.maxY);
      finalBuffer = cropped.buffer;
      isRegionCrop = true;
      labelText = `**cropped** *X:${region.minX}–${region.maxX}, Y:${region.minY}–${region.maxY} (${cropped.width}×${cropped.height})*`;
    } else if (isCenterCrop) {
      finalBuffer = await TemplateMatcher.cropCenter(screenBuffer, centerCropSize, centerCropSize);
      labelText = `**cropped** *${centerCropSize}×${centerCropSize}*`;
    }

    // Check if "save" was requested
    const saveIdx = ctx.args.findIndex((a) => a.toLowerCase() === 'save');
    const shouldSave = saveIdx !== -1;
    let savedFileName = `screen_${Date.now()}.png`;

    if (shouldSave) {
      const customName = ctx.args[saveIdx + 1];
      if (customName && !customName.includes('-')) {
        const clean = path.basename(customName.trim());
        savedFileName = /\.(png|jpg|jpeg)$/i.test(clean) ? clean : `${clean}.png`;
      } else {
        savedFileName = isRegionCrop ? `crop_${Date.now()}.png` : `screen_${Date.now()}.png`;
      }

      const homeDir = process.env.HOME || os.homedir() || '';
      const sharedDirs = [
        path.resolve(homeDir, 'storage/shared/autoclick'),
        '/sdcard/autoclick',
        '/storage/emulated/0/autoclick'
      ];

      let targetDir = sharedDirs[0];
      for (const dir of sharedDirs) {
        if (fs.existsSync(dir)) {
          targetDir = dir;
          break;
        }
        const parent = path.dirname(dir);
        if (fs.existsSync(parent)) {
          targetDir = dir;
          break;
        }
      }

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const fullSavePath = path.join(targetDir, savedFileName);
      await fs.promises.writeFile(fullSavePath, finalBuffer);
      ctx.log(`💾 Saved permanent image to ${fullSavePath}`, 'info');
      labelText = `**saved** \`${savedFileName}\``;
    }

    if (webhook.isConfigured()) {
      await webhook.send({
        content: labelText,
        fileBuffer: finalBuffer,
        fileName: savedFileName
      });
      ctx.log('✅ Screenshot sent to Discord Webhook', 'info');
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
        ? `running \`start\` (step ${startState.currentStep}, cycle #${startState.cycleCount})`
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
      const output = `connected ${target}`;
      if (ctx.reply) await ctx.reply(output);
      return { success: true, message: output, data: result };
    }

    // If direct connect failed, fall back to nmap scan (30000-40000) & 10s auto-retry loop
    const autoFound = await adb.autoConnectWithRetry();
    if (autoFound) {
      botManager.updateConfig({ adbHost: autoFound, adbSerial: autoFound });
      return { success: true, message: `connected ${autoFound}` };
    }
    return { success: false, message: 'connection failed' };
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
  description: 'Stops any currently running macro (before step 1) or stops ADB auto-connect retries.',
  usage: 'stop',

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { MacroManager } = await import('../macroManager');
    const { botManager } = await import('../botManager');
    const { stopSub, getRunningSubOption } = await import('./sub');
    const adb = botManager.getAdbController();

    const stoppedAutoConnect = adb.stopAutoConnect();
    const subOpt = getRunningSubOption();
    const stoppedSub = stopSub();

    if (MacroManager.isFindRunning()) {
      await MacroManager.waitForFind();
    }
    const runningName = MacroManager.getRunningMacro();
    if (runningName) {
      MacroManager.stopAll();
      const stopTargetDesc =
        runningName.toLowerCase() === 'start' ? 'before step 1, 7, or 13' : 'before step 1';
      const msg = stoppedAutoConnect
        ? `stopped adb auto-connect & stopping ${runningName} right ${stopTargetDesc}...`
        : `stopping ${runningName} right ${stopTargetDesc}...`;
      if (ctx.reply) await ctx.reply(msg);
      return { success: true, message: msg };
    }

    if (stoppedSub) {
      const msg = `stopping \`sub ${subOpt}\`...`;
      if (ctx.reply) await ctx.reply(msg);
      return { success: true, message: msg };
    }

    if (stoppedAutoConnect) {
      return { success: true, message: 'stopped adb auto-connect' };
    }

    const msg = 'nothing running';
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
    const os = await import('os');

    const homeDir = process.env.HOME || os.homedir() || '';
    const sharedDirs = [
      path.resolve(homeDir, 'storage/shared/autoclick'),
      '/sdcard/autoclick',
      '/storage/emulated/0/autoclick'
    ];

    let targetDir = sharedDirs[0];
    for (const dir of sharedDirs) {
      if (fs.existsSync(dir)) {
        targetDir = dir;
        break;
      }
    }

    if (!fs.existsSync(targetDir)) {
      const msg = 'no saved images';
      if (ctx.reply) await ctx.reply(msg);
      return { success: true, message: msg };
    }

    const sub = ctx.args[0]?.toLowerCase();
    if (sub === 'delete' || sub === 'del' || sub === 'rm' || sub === 'remove') {
      const targetName = ctx.args[1];
      if (!targetName) {
        const msg = 'usage: images delete <filename>';
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      const clean = path.basename(targetName.trim());
      const candidates = [clean, `${clean}.png`, `${clean}.jpg`, `${clean}.jpeg`];
      let deletedFile: string | null = null;

      for (const candidate of candidates) {
        const fullPath = path.join(targetDir, candidate);
        if (fs.existsSync(fullPath)) {
          await fs.promises.unlink(fullPath);
          deletedFile = candidate;
          break;
        }
      }

      const msg = deletedFile ? `deleted \`${deletedFile}\`` : `file "${clean}" not found`;
      if (ctx.reply) await ctx.reply(msg);
      return { success: Boolean(deletedFile), message: msg };
    }

    const entries = await fs.promises.readdir(targetDir);
    const imageFiles = entries.filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f));

    if (imageFiles.length === 0) {
      const msg = 'no saved images in autoclick folder';
      if (ctx.reply) await ctx.reply(msg);
      return { success: true, message: msg };
    }

    if (webhook.isConfigured()) {
      for (const fileName of imageFiles) {
        try {
          const fullPath = path.join(targetDir, fileName);
          const buf = await fs.promises.readFile(fullPath);
          await webhook.send({
            content: `\`${fileName}\``,
            fileBuffer: buf,
            fileName
          });
        } catch {
          // ignore unreadable file
        }
      }
    } else if (ctx.reply) {
      await ctx.reply(imageFiles.map((f) => `\`${f}\``).join('\n'));
    }

    return {
      success: true,
      message: `sent ${imageFiles.length} images`,
      data: { files: imageFiles }
    };
  }
};

export const testCommand: CommandDefinition = {
  name: 'test',
  description: 'Benchmarks BOTH the old PNG file method and the new RAM memory method side-by-side and compares their times.',
  usage: 'test [imageName] [minX-maxX minY-maxY]',
  aliases: ['benchmark', 'speed', 'speedtest', 'timetest', 'match-test', 'compare-test'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const { botManager } = await import('../botManager');
    const { TemplateMatcher } = await import('../matcher');
    const { RefImageManager } = await import('../refImage');
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    const adb = botManager.getAdbController();
    const config = botManager.getConfig();

    // Resolve image & optional crop region
    let targetImageName = 'asbtn.png';
    let customRegion: { minX: number; maxX: number; minY: number; maxY: number } | undefined;
    let tempMinX = 0;
    let tempMaxX = 0;
    let rangeIndex = 0;

    for (const arg of ctx.args) {
      if (arg.includes('-')) {
        const parts = arg.split('-').map(Number);
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
          if (rangeIndex === 0) {
            tempMinX = parts[0];
            tempMaxX = parts[1];
            rangeIndex++;
          } else {
            customRegion = {
              minX: tempMinX,
              maxX: tempMaxX,
              minY: parts[0],
              maxY: parts[1]
            };
          }
        }
      } else if (arg.trim()) {
        targetImageName = arg.trim();
      }
    }

    const region =
      customRegion ||
      (targetImageName === 'asbtn.png' && ctx.args.length === 0
        ? { minX: 771, maxX: 840, minY: 1107, maxY: 1176 }
        : undefined);

    // Resolve template image path
    const homeDir = process.env.HOME || os.homedir() || '';
    const sharedDirs = [
      path.resolve(homeDir, 'storage/shared/autoclick'),
      '/sdcard/autoclick',
      '/storage/emulated/0/autoclick'
    ];
    let resolvedImgPath = '';
    for (const dir of sharedDirs) {
      const candidate = path.join(dir, targetImageName);
      if (fs.existsSync(candidate)) {
        resolvedImgPath = candidate;
        break;
      }
      const withPng = path.join(dir, `${targetImageName}.png`);
      if (fs.existsSync(withPng)) {
        resolvedImgPath = withPng;
        break;
      }
      const withJpg = path.join(dir, `${targetImageName}.jpg`);
      if (fs.existsSync(withJpg)) {
        resolvedImgPath = withJpg;
        break;
      }
    }

    if (!resolvedImgPath) {
      if (targetImageName.toLowerCase().startsWith('pfp')) {
        resolvedImgPath = await RefImageManager.ensureRefImage();
      } else {
        const notFound = `image "${targetImageName}" not found in /sdcard/autoclick/`;
        if (ctx.reply) await ctx.reply(notFound);
        return { success: false, message: notFound };
      }
    }

    const effectiveThreshold = config.matchThreshold || 0.75;
    const scales = [0.7, 0.85, 1.0, 1.15, 1.3];

    if (ctx.reply) {
      await ctx.reply(`⏳ Running side-by-side speed test (**PNG File** vs **RAM Memory**) on \`${path.basename(resolvedImgPath)}\`...`);
    }

    // =========================================================================
    // TEST 1: OLD PNG FILE METHOD (adb screencap -p > file + PNG decode + match)
    // =========================================================================
    const tPngCapStart = Date.now();
    let pngBuffer: Buffer;
    try {
      pngBuffer = await adb.screencap();
    } catch (err: any) {
      const msg = `test failed: PNG screencap error (${err.message})`;
      if (ctx.reply) await ctx.reply(msg);
      return { success: false, message: msg };
    }
    const pngCapMs = Date.now() - tPngCapStart;

    const tPngMatchStart = Date.now();
    const pngMatch = await TemplateMatcher.match(pngBuffer, resolvedImgPath, {
      scales,
      threshold: effectiveThreshold,
      drawDebugBox: false,
      region
    });
    const pngMatchMs = Date.now() - tPngMatchStart;
    const pngTotalMs = pngCapMs + pngMatchMs;

    // =========================================================================
    // TEST 2: NEW RAM MEMORY METHOD (adb screencap raw + RAM slice + cached match)
    // =========================================================================
    const tRamCapStart = Date.now();
    let rawScreen: { data: Buffer; width: number; height: number; headerSize: number };
    try {
      rawScreen = await adb.screencapRaw();
    } catch (err: any) {
      const msg = `test failed: Raw RAM screencap error (${err.message})`;
      if (ctx.reply) await ctx.reply(msg);
      return { success: false, message: msg };
    }
    const ramCapMs = Date.now() - tRamCapStart;

    const tRamColdStart = Date.now();
    await TemplateMatcher.matchRaw(rawScreen, resolvedImgPath, {
      scales,
      threshold: effectiveThreshold,
      region
    });
    const ramColdMatchMs = Date.now() - tRamColdStart;

    const tRamWarmStart = Date.now();
    const ramMatch = await TemplateMatcher.matchRaw(rawScreen, resolvedImgPath, {
      scales,
      threshold: effectiveThreshold,
      region
    });
    const ramMatchMs = Date.now() - tRamWarmStart;
    const ramTotalMs = ramCapMs + ramMatchMs;

    const imgBaseName = path.basename(resolvedImgPath);
    const pngScorePct = (pngMatch.score * 100).toFixed(1);
    const ramScorePct = (ramMatch.score * 100).toFixed(1);
    const regionStr = region
      ? `X:[${region.minX}..${region.maxX}], Y:[${region.minY}..${region.maxY}]`
      : `Full Screen (${rawScreen.width}×${rawScreen.height})`;

    const speedup = ramTotalMs > 0 ? (pngTotalMs / ramTotalMs).toFixed(2) : '1.00';
    const savedMs = pngTotalMs - ramTotalMs;

    const summary = [
      `⚡ **Speed Test: PNG File vs RAM Memory (\`${imgBaseName}\`)**`,
      `• **Search Area:** \`${regionStr}\``,
      ``,
      `🐢 **1. PNG File Method (Current):** **\`${pngTotalMs} ms\` total**`,
      `• Screenshot (\`screencap -p\` file): **${pngCapMs} ms**`,
      `• PNG Decode + Compare: **${pngMatchMs} ms**`,
      `• Match: **${pngMatch.found ? 'FOUND ✅' : 'NOT FOUND ❌'}** (${pngScorePct}%) at \`(${pngMatch.targetPoint.x}, ${pngMatch.targetPoint.y})\``,
      ``,
      `🚀 **2. RAM Memory Method (New):** **\`${ramTotalMs} ms\` total**`,
      `• Screenshot (Raw RAM buffer): **${ramCapMs} ms**`,
      `• RAM Slice + Compare: **${ramMatchMs} ms** *(1st cold load: ${ramColdMatchMs} ms)*`,
      `• Match: **${ramMatch.found ? 'FOUND ✅' : 'NOT FOUND ❌'}** (${ramScorePct}%) at \`(${ramMatch.targetPoint.x}, ${ramMatch.targetPoint.y})\``,
      ``,
      `🏆 **Winner:** ${
        savedMs > 0
          ? `**RAM Memory is ${speedup}x faster** (saves **${savedMs} ms** per check!)`
          : `**PNG File was faster by ${Math.abs(savedMs)} ms**`
      }`
    ].join('\n');

    ctx.log(
      `[SpeedTest] PNG: ${pngTotalMs}ms (cap ${pngCapMs}ms + match ${pngMatchMs}ms) | RAM: ${ramTotalMs}ms (cap ${ramCapMs}ms + match ${ramMatchMs}ms)`,
      'info'
    );
    if (ctx.reply) await ctx.reply(summary);

    return {
      success: true,
      message: summary,
      data: {
        png: { capMs: pngCapMs, matchMs: pngMatchMs, totalMs: pngTotalMs, score: pngMatch.score },
        ram: { capMs: ramCapMs, matchMs: ramMatchMs, totalMs: ramTotalMs, score: ramMatch.score, coldMatchMs: ramColdMatchMs }
      }
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
      const msg = `🛑 **Live Control OFF** (port ${LIVE_PORT} & Cloudflare tunnel closed)`;
      ctx.log(msg, 'info');
      if (ctx.reply) await ctx.reply(msg);
      return { success: true, message: msg, data: status };
    }

    if (sub !== 'local' && sub !== 'net' && sub !== 'all') {
      const usageMsg = 'usage: `live local` | `live net` | `live all` | `live stop`';
      if (ctx.reply) await ctx.reply(usageMsg);
      return { success: false, message: usageMsg };
    }

    const mode: 'local' | 'net' | 'all' = sub;

    if (ctx.reply) {
      const modeLabel =
        mode === 'local' ? 'Local Wi-Fi Only' : mode === 'net' ? 'Internet Only' : 'Local Wi-Fi + Internet';
      await ctx.reply(`⏳ Stopping local scripts & starting Live Control (**${modeLabel}**, port ${LIVE_PORT})...`);
    }

    const status = await LiveController.startLiveTunnel(LIVE_PORT, (m) => ctx.log(m, 'info'), mode);

    const lines: string[] = [];
    if (mode === 'local') {
      lines.push(`🟢 **Live Control Active — Local Wi-Fi Only (Port ${LIVE_PORT})** *(all local scripts stopped)*`);
      lines.push(`• **Local Wi-Fi:** ${status.localUrl}`);
    } else if (mode === 'net') {
      lines.push(`🟢 **Live Control Active — Internet Only** *(all local scripts stopped, fast compressed stream)*`);
      lines.push(
        status.publicUrl
          ? `• **Internet (Anywhere):** ${status.publicUrl}`
          : `• **Internet Tunnel:** unavailable (${status.error || 'check cloudflared'})`
      );
    } else {
      lines.push(`🟢 **Live Control Active — Local Wi-Fi + Internet (Port ${LIVE_PORT})** *(all local scripts stopped)*`);
      lines.push(`• **Local Wi-Fi:** ${status.localUrl}`);
      lines.push(
        status.publicUrl
          ? `• **Internet (Anywhere):** ${status.publicUrl}`
          : `• **Internet Tunnel:** unavailable (${status.error || 'check cloudflared'})`
      );
    }
    lines.push(`*(send \`live stop\` when finished to shut down)*`);

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

  test: [
    '**test** — Test comparing asbtn.png in region 725-800 951-1022 & see click target without tapping',
    'usage:',
    '• `test` — captures screen, crops `X:725–800, Y:951–1022`, compares to `asbtn.png` & shows execution time and would-click position',
    '• `test <image>` — tests custom image from `/sdcard/autoclick/`',
    '• `test <image> <minX>-<maxX> <minY>-<maxY>` — tests image against custom crop region (e.g. `test btn.png 100-300 400-600`)'
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
    '• `tap <minX>-<maxX> <minY>-<maxY>` — random tap in box (e.g. `tap 227-766 2326-2387`)',
    '• `wait <ms or Ns>` — wait time (e.g. `wait 2000` or `wait 3s`)',
    '• `search <img>` — find image from `autoclick/` on screen & tap it (e.g. `search btn.jpg`)',
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
    '**tap** — Tap coordinates on screen via ADB',
    'usage:',
    '• `tap <x> <y>` — taps exact coordinate (e.g. `tap 540 1200`)',
    '• `tap <minX>-<maxX> <minY>-<maxY>` — taps random point inside box (e.g. `tap 200-400 800-900`)'
  ].join('\n'),

  screenshot: [
    '**screenshot** — Capture screen, crop area & optionally save to sdcard',
    'usage:',
    '• `screenshot` — captures full Android screen and sends to webhook',
    '• `screenshot <minX>-<maxX> <minY>-<maxY>` — crops only that X/Y area and sends it without saving (e.g. `screenshot 79-220 523-1721`)',
    '• `screenshot <minX>-<maxX> <minY>-<maxY> save <name>` — crops area, permanently saves to `/sdcard/autoclick/<name>.png`, and sends the cropped image & name to Discord (e.g. `screenshot 200-400 800-900 save btn`)',
    '• `screenshot crop` — captures screen and crops 150×150 center'
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
      '**bot manual** — send `help <command>` for detailed usage (e.g. `help macro`, `help test`, `help find`)',
      '• `ai` — Gemini Vision unexpected prompt learner (`help ai`)',
      '• `find` — run automated pfp search, tap & 150×150 center crop sequence',
      '• `test` — benchmark time taken to capture, crop & compare an image (`help test`)',
      '• `macro` — create & manage custom multi-step commands (`help macro`)',
      '• `tap` — tap exact `X Y` or random `minX-maxX minY-maxY` (`help tap`)',
      '• `screenshot` — capture full screen, crop `X Y` area, or save to sdcard (`help screenshot`)',
      '• `images` — send all saved images & names from `/sdcard/autoclick/` (`help images`)',
      '• `connect` / `pair` / `devices` — wireless ADB connection tools (`help connect`)',
      '• `status` — check ADB device & bot status',
      '• `update` / `check-update` / `restart` — GitHub auto-updater & process control',
      `• custom commands: ${customList}`
    ].join('\n');

    if (ctx.reply) await ctx.reply(manualOverview);
    return { success: true, message: manualOverview };
  }
};
