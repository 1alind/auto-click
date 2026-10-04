import { CommandDefinition, CommandContext, CommandResult } from '../types';
import { aiLearner } from '../aiLearner';
import { botManager } from '../botManager';

export const aiCommand: CommandDefinition = {
  name: 'ai',
  description: 'AI Prompt Learning & Rescue: analyzes screen with Gemini 3.8 Flash Vision, resolves unexpected prompts, and saves them to sdcard for future offline reuse.',
  usage: 'ai [list | forget <id> | test]',
  aliases: ['airescue', 'learned', 'prompts'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const subCommand = ctx.args[0]?.toLowerCase();
    const config = botManager.getConfig();
    const adb = botManager.getAdbController();
    const webhook = botManager.getWebhookService();

    // 1. ai list / learned
    if (subCommand === 'list' || subCommand === 'show') {
      const list = aiLearner.getLearnedPrompts();
      if (list.length === 0) {
        const msg = `📁 **Learned Prompts**: None yet!\nStorage directory: \`${aiLearner.getStorageDir()}\`\nWhen an unexpected dialog appears, Gemini will automatically learn it and save it here.`;
        if (ctx.reply) await ctx.reply(msg);
        return { success: true, message: msg };
      }

      const lines = [
        `🧠 **Learned Prompts Saved on SDCard** (${list.length}):`,
        `📁 Storage: \`${aiLearner.getStorageDir()}\`\n`
      ];

      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        lines.push(
          `**${i + 1}. \`${p.name}\`** (ID: \`${p.id}\`)\n` +
            `• Target Click: \`(${p.clickX}, ${p.clickY})\`\n` +
            `• Action: ${p.description}\n` +
            `• Reused Offline: **${p.timesUsed || 1} times** (Saved: ${new Date(p.learnedAt).toLocaleDateString()})\n`
        );
      }

      const output = lines.join('\n');
      if (ctx.reply) await ctx.reply(output);
      return { success: true, message: output };
    }

    // 2. ai forget <id>
    if (subCommand === 'forget' || subCommand === 'delete' || subCommand === 'remove') {
      const targetId = ctx.args[1];
      if (!targetId) {
        const err = 'Usage: `ai forget <prompt_name_or_id>` (run `ai list` to see IDs)';
        if (ctx.reply) await ctx.reply(err);
        return { success: false, message: err };
      }

      const forgotten = aiLearner.forgetPrompt(targetId);
      const resMsg = forgotten
        ? `🗑️ Successfully forgot learned prompt \`${targetId}\` and removed its template from sdcard.`
        : `⚠️ Could not find learned prompt \`${targetId}\`. Run \`ai list\` to view all learned prompts.`;
      if (ctx.reply) await ctx.reply(resMsg);
      return { success: forgotten, message: resMsg };
    }

    // 3. ai / ai test: Analyze current screen with Gemini 3.8 Flash Vision
    const isTest = subCommand === 'test';
    if (ctx.reply) {
      await ctx.reply(`🧠 Scanning screen with **Gemini 3.8 Flash Vision**...`);
    }

    const result = await aiLearner.rescueWithGeminiAndLearn(adb, {
      customApiKey: config.geminiApiKey,
      log: (msg, lvl) => ctx.log(msg, lvl || 'info')
    });

    if (!result.success) {
      const errMsg = `❌ AI Rescue failed: ${result.message}`;
      if (ctx.reply) await ctx.reply(errMsg);
      return { success: false, message: errMsg };
    }

    if (!result.promptDetected) {
      const noPromptMsg = '✅ Screen is clear! No unexpected prompt, popup, or modal detected.';
      if (ctx.reply) await ctx.reply(noPromptMsg);
      return { success: true, message: noPromptMsg };
    }

    const successMsg = [
      `🎉 **Gemini AI Detected & Learned Prompt!**`,
      `• **Name**: \`${result.name}\``,
      `• **Description**: ${result.description}`,
      `• **Clicked At**: \`(${result.clickCoords?.x}, ${result.clickCoords?.y})\``,
      `• 💾 **Saved to SDCard**: \`${result.savedTemplatePath}\``,
      `*(Next time this exact prompt appears, the bot will tap it in 5ms 100% offline without asking the AI!)*`
    ].join('\n');

    if (ctx.reply) await ctx.reply(successMsg);
    return { success: true, message: successMsg };
  }
};
