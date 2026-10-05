import { CommandDefinition, CommandContext, CommandResult } from '../types';
import { screenRuleManager, ScreenRuleAction } from '../screenRuleManager';
import { botManager } from '../botManager';

export const ruleCommand: CommandDefinition = {
  name: 'rule',
  description: 'Manage screen recognition rules (zero AI). Sets what happens when unexpected dialogs or screens appear.',
  usage: 'rule [list | set <id> <tap x y | back> | delete <id> | test]',
  aliases: ['rules', 'screen', 'screens', 'prompt', 'prompts'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const subCommand = ctx.args[0]?.toLowerCase();
    const adb = botManager.getAdbController();

    // 1. rule list
    if (!subCommand || subCommand === 'list' || subCommand === 'show') {
      const list = screenRuleManager.getRules();
      if (list.length === 0) {
        const latest = screenRuleManager.getLatestPendingScreen();
        let msg = `📋 **Screen Rules**: None configured yet!\nStorage: \`${screenRuleManager.getStorageDir()}/screen_rules.json\`\n`;
        if (latest) {
          msg += `\n⚠️ **Latest Detected Screen Waiting for Action**: \`${latest.id}\`\n• Detected info: \`${latest.ocrSnippet}\`\n• To set action: \`rule set tap <x> <y>\` or \`rule set back\``;
        } else {
          msg += `\nWhen an unknown screen blocks a macro, the bot sends a full-screen screenshot to Discord with an assigned Screen ID so you can configure it!`;
        }
        if (ctx.reply) await ctx.reply(msg);
        return { success: true, message: msg };
      }

      const lines = [
        `📋 **Configured Screen Rules** (${list.length}):`,
        `📁 Storage: \`${screenRuleManager.getStorageDir()}/screen_rules.json\`\n`
      ];

      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        let actionDesc = 'Unknown';
        if (r.action.type === 'tap') {
          actionDesc = `Tap \`(${r.action.x}, ${r.action.y})\``;
        } else if (r.action.type === 'tap_range') {
          actionDesc = `Tap range \`${r.action.minX}-${r.action.maxX}, ${r.action.minY}-${r.action.maxY}\``;
        } else if (r.action.type === 'back') {
          actionDesc = `Press \`Back\` button`;
        }

        lines.push(
          `**${i + 1}. \`${r.id}\`**\n` +
            `• Action: **${actionDesc}**\n` +
            `• Unique Keywords: ${r.keywords.map((k) => `\`${k}\``).join(', ')}\n` +
            `• Triggered: **${r.timesTriggered || 0} times** (Created: ${new Date(r.createdAt).toLocaleDateString()})\n`
        );
      }

      const output = lines.join('\n');
      if (ctx.reply) await ctx.reply(output);
      return { success: true, message: output };
    }

    // 2. rule set [id] <tap x y | back>
    if (subCommand === 'set' || subCommand === 'add') {
      let targetId = ctx.args[1];
      let actionTypeIndex = 2;

      // Check if user omitted ID and wrote: rule set tap 500 730 OR rule set back
      if (
        targetId?.toLowerCase() === 'tap' ||
        targetId?.toLowerCase() === 'back' ||
        targetId?.toLowerCase() === 'click'
      ) {
        actionTypeIndex = 1;
        const pending = screenRuleManager.getLatestPendingScreen();
        if (!pending) {
          const err = '⚠️ No recent unknown screen found. Please specify Screen ID: `rule set <screen_id> tap <x> <y>`';
          if (ctx.reply) await ctx.reply(err);
          return { success: false, message: err };
        }
        targetId = pending.id;
      } else if (targetId?.toLowerCase() === 'latest') {
        actionTypeIndex = 2;
        const pending = screenRuleManager.getLatestPendingScreen();
        if (!pending) {
          const err = '⚠️ No recent unknown screen found. Please specify Screen ID: `rule set <screen_id> tap <x> <y>`';
          if (ctx.reply) await ctx.reply(err);
          return { success: false, message: err };
        }
        targetId = pending.id;
      }

      const actionKeyword = ctx.args[actionTypeIndex]?.toLowerCase();

      let action: ScreenRuleAction | null = null;
      let actionEndIndex = actionTypeIndex + 1;

      if (actionKeyword === 'back' || actionKeyword === 'keyback') {
        action = { type: 'back' };
        actionEndIndex = actionTypeIndex + 1;
      } else if (actionKeyword === 'tap' || actionKeyword === 'click') {
        const argX = ctx.args[actionTypeIndex + 1];
        const argY = ctx.args[actionTypeIndex + 2];

        if (argX && (argX.includes('-') || (argY && argY.includes('-')))) {
          const [minX, maxX] = (argX || '0-0').split('-').map(Number);
          const [minY, maxY] = (argY || '0-0').split('-').map(Number);
          action = { type: 'tap_range', minX, maxX, minY, maxY };
          actionEndIndex = actionTypeIndex + (argY ? 3 : 2);
        } else {
          const x = parseInt(argX, 10);
          const y = parseInt(argY, 10);
          if (isNaN(x) || isNaN(y)) {
            const err = `⚠️ Invalid tap coordinates. Usage: \`rule set ${targetId} tap <x> <y> [keywords...]\``;
            if (ctx.reply) await ctx.reply(err);
            return { success: false, message: err };
          }
          action = { type: 'tap', x, y };
          actionEndIndex = actionTypeIndex + 3;
        }
      }

      if (!action) {
        const err = `⚠️ Unknown action. Usage:\n• \`rule set ${targetId || '<id>'} tap <x> <y> [keywords...]\`\n• \`rule set ${targetId || '<id>'} back [keywords...]\``;
        if (ctx.reply) await ctx.reply(err);
        return { success: false, message: err };
      }

      // Check for optional custom keywords passed in command: rule add <id> tap 500 730 keywords: word1, word2
      let customKeywords: string[] | undefined = undefined;
      const remainingArgs = ctx.args.slice(actionEndIndex);
      if (remainingArgs.length > 0) {
        const rawKw = remainingArgs.join(' ').replace(/^keywords?:?/i, '').trim();
        if (rawKw) {
          customKeywords = rawKw.split(/[,;]+/).map((k) => k.trim()).filter(Boolean);
        }
      }

      const rule = screenRuleManager.setRule(targetId, action, {
        keywords: customKeywords
      });
      const actionDesc =
        rule.action.type === 'tap'
          ? `tap \`(${rule.action.x}, ${rule.action.y})\``
          : rule.action.type === 'back'
          ? `press Android \`Back\` button`
          : `tap range \`${rule.action.minX}-${rule.action.maxX}, ${rule.action.minY}-${rule.action.maxY}\``;

      const replyMsg = `✅ **Screen Rule Configured**!\n• **Screen ID**: \`${rule.id}\`\n• **Action**: Whenever this screen appears, the bot will ${actionDesc}.\n• **Keywords**: ${rule.keywords.map((k) => `\`${k}\``).join(', ')}`;
      ctx.log(replyMsg, 'info');
      if (ctx.reply) await ctx.reply(replyMsg);
      return { success: true, message: replyMsg };
    }

    // 3. rule capture <id> <tap x y | back> (Captures current phone screen, extracts keywords, saves rule)
    if (subCommand === 'capture' || subCommand === 'from-screen') {
      const targetId = ctx.args[1];
      if (!targetId || targetId === 'tap' || targetId === 'back') {
        const err = 'Usage: `rule capture <screen_id> tap <x> <y>` or `rule capture <screen_id> back`';
        if (ctx.reply) await ctx.reply(err);
        return { success: false, message: err };
      }

      const actionKeyword = ctx.args[2]?.toLowerCase();
      let action: ScreenRuleAction | null = null;
      if (actionKeyword === 'back' || actionKeyword === 'keyback') {
        action = { type: 'back' };
      } else if (actionKeyword === 'tap' || actionKeyword === 'click') {
        const argX = ctx.args[3];
        const argY = ctx.args[4];
        if (argX && (argX.includes('-') || (argY && argY.includes('-')))) {
          const [minX, maxX] = (argX || '0-0').split('-').map(Number);
          const [minY, maxY] = (argY || '0-0').split('-').map(Number);
          action = { type: 'tap_range', minX, maxX, minY, maxY };
        } else {
          const x = parseInt(argX, 10);
          const y = parseInt(argY, 10);
          if (!isNaN(x) && !isNaN(y)) {
            action = { type: 'tap', x, y };
          }
        }
      }

      if (!action) {
        const err = 'Usage: `rule capture <screen_id> tap <x> <y>` or `rule capture <screen_id> back`';
        if (ctx.reply) await ctx.reply(err);
        return { success: false, message: err };
      }

      if (ctx.reply) await ctx.reply(`📸 Capturing current phone screen for rule \`${targetId}\`...`);
      const screenshot = await adb.screencap();
      const { recognizeLinesWithTimeout } = await import('./fixac');
      const ocrRes = await recognizeLinesWithTimeout(screenshot, 0, 0, 1, 5000);
      const keywords = screenRuleManager.extractUniqueKeywords(ocrRes.fullText || '');

      const rule = screenRuleManager.setRule(targetId, action, {
        keywords,
        snippet: ocrRes.lines?.slice(0, 3).map((l) => l.text).join(' | ') || ocrRes.fullText?.slice(0, 100)
      });

      const actionDesc =
        rule.action.type === 'tap'
          ? `tap \`(${rule.action.x}, ${rule.action.y})\``
          : rule.action.type === 'back'
          ? `press Android \`Back\` button`
          : `tap range \`${rule.action.minX}-${rule.action.maxX}, ${rule.action.minY}-${rule.action.maxY}\``;

      const replyMsg = `✅ **Captured & Saved Screen Rule**!\n• **Screen ID**: \`${rule.id}\`\n• **Action**: ${actionDesc}\n• **Scanned Keywords**: ${rule.keywords.map((k) => `\`${k}\``).join(', ')}`;
      ctx.log(replyMsg, 'info');
      if (ctx.reply) await ctx.reply(replyMsg);
      return { success: true, message: replyMsg };
    }

    // 3. rule id <new_id> (Changes the ID of the latest pending screen)
    if (subCommand === 'id' || subCommand === 'setid' || subCommand === 'name') {
      const newId = ctx.args[1];
      if (!newId) {
        const pending = screenRuleManager.getLatestPendingScreen();
        const cur = pending ? `\`${pending.id}\`` : 'None';
        const msg = `Usage: \`rule id <new_id>\` (Current pending screen ID is ${cur})`;
        if (ctx.reply) await ctx.reply(msg);
        return { success: false, message: msg };
      }

      const pending = screenRuleManager.getLatestPendingScreen();
      if (!pending) {
        const err = '⚠️ No pending unknown screen found to rename. To rename an existing rule, use: `rule rename <old_id> <new_id>`';
        if (ctx.reply) await ctx.reply(err);
        return { success: false, message: err };
      }

      const oldId = pending.id;
      const ok = screenRuleManager.setPendingId(newId);
      if (ok) {
        const msg = `🏷️ Changed pending Screen ID from \`${oldId}\` to \`${pending.id}\`!\nYou can now set its action: \`rule set ${pending.id} tap <x> <y>\` or \`rule set ${pending.id} back\``;
        if (ctx.reply) await ctx.reply(msg);
        return { success: true, message: msg };
      } else {
        const err = `⚠️ Invalid ID format: "${newId}". Please use letters, numbers, and underscores.`;
        if (ctx.reply) await ctx.reply(err);
        return { success: false, message: err };
      }
    }

    // 4. rule rename <old_id> <new_id> (Renames an existing saved rule)
    if (subCommand === 'rename') {
      const oldId = ctx.args[1];
      const newId = ctx.args[2];

      if (!oldId || !newId) {
        const err = 'Usage: `rule rename <old_screen_id> <new_screen_id>`';
        if (ctx.reply) await ctx.reply(err);
        return { success: false, message: err };
      }

      const res = screenRuleManager.renameRule(oldId, newId);
      const msg = res.success
        ? `🏷️ Successfully renamed screen ID from \`${oldId}\` to \`${res.rule?.id}\`!`
        : `⚠️ ${res.message}`;
      if (ctx.reply) await ctx.reply(msg);
      return { success: res.success, message: msg };
    }

    // 5. rule delete / forget
    if (subCommand === 'delete' || subCommand === 'remove' || subCommand === 'forget') {
      const targetId = ctx.args[1];
      if (!targetId) {
        const err = 'Usage: `rule delete <screen_id>` (run `rule list` to view IDs)';
        if (ctx.reply) await ctx.reply(err);
        return { success: false, message: err };
      }

      const deleted = screenRuleManager.deleteRule(targetId);
      const resMsg = deleted
        ? `🗑️ Successfully deleted screen rule \`${targetId}\`.`
        : `⚠️ Screen rule \`${targetId}\` not found. Run \`rule list\` to view all rules.`;
      if (ctx.reply) await ctx.reply(resMsg);
      return { success: deleted, message: resMsg };
    }

    // 4. rule test / scan: Scans current screen right now
    if (subCommand === 'test' || subCommand === 'scan') {
      if (ctx.reply) await ctx.reply('🔍 Scanning phone screen with local OCR...');
      const checkRes = await screenRuleManager.checkAndExecuteRule(adb);
      if (checkRes.matched && checkRes.rule) {
        const actionDesc =
          checkRes.rule.action.type === 'tap'
            ? `tapped (${checkRes.rule.action.x}, ${checkRes.rule.action.y})`
            : 'pressed Back button';
        const msg = `🎯 **Matched Screen Rule**: \`${checkRes.rule.id}\`!\n• Executed action: ${actionDesc}`;
        if (ctx.reply) await ctx.reply(msg);
        return { success: true, message: msg };
      }

      // No rule matched, show what keywords OCR sees
      const screenshot = await adb.screencap();
      const webhook = botManager.getWebhookService();
      const pending = await screenRuleManager.handleUnknownScreen(adb, webhook, ctx, {
        macroName: 'manual-test',
        stepNumber: 0,
        targetName: 'current-screen'
      });

      const msg = `ℹ️ No rule currently matches this screen.\n• Assigned Screen ID: \`${pending.id}\`\n• Detected info: \`${pending.ocrSnippet}\`\n• To set an action: \`rule set ${pending.id} tap <x> <y>\``;
      if (ctx.reply) await ctx.reply(msg);
      return { success: true, message: msg };
    }

    const helpMsg = [
      `🛡️ **Screen Rules (Zero AI Automation)**`,
      `• \`rule list\`: View all configured rules`,
      `• \`rule add <id> tap <x> <y> [keywords...]\`: Manually add a rule with custom keywords`,
      `• \`rule add <id> back [keywords...]\`: Manually add Back button rule with custom keywords`,
      `• \`rule capture <id> tap <x> <y>\`: Capture current phone screen & auto-extract keywords into rule`,
      `• \`rule capture <id> back\`: Capture current phone screen & set Back action`,
      `• \`rule id <new_id>\`: Change the Screen ID of the latest detected screen`,
      `• \`rule rename <old_id> <new_id>\`: Rename an existing saved screen rule`,
      `• \`rule delete <id>\`: Delete a rule`,
      `• \`rule scan\`: Scan current screen and preview assigned Screen ID`
    ].join('\n');

    if (ctx.reply) await ctx.reply(helpMsg);
    return { success: true, message: helpMsg };
  }
};
