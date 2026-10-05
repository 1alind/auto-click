import { CommandDefinition, CommandContext, CommandResult } from '../types';

export const clearCommand: CommandDefinition = {
  name: 'clear',
  description: 'Clears/purges recent messages from the Discord channel.',
  usage: 'clear [amount] (e.g. clear 50, clear 100, or clear all)',
  aliases: ['purge', 'clean', 'cls'],

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const rawMsg = ctx.discordMessage;
    if (!rawMsg || !rawMsg.channel) {
      const msg = '⚠️ Clear command is only available inside Discord channels.';
      if (ctx.reply) await ctx.reply(msg);
      return { success: false, message: msg };
    }

    const channel = rawMsg.channel;
    if (!('bulkDelete' in channel)) {
      const msg = '⚠️ Cannot bulk delete messages in DMs or non-text channels.';
      if (ctx.reply) await ctx.reply(msg);
      return { success: false, message: msg };
    }

    const targetArg = ctx.args[0]?.toLowerCase();
    let count = 50;

    if (targetArg === 'all') {
      count = 100;
    } else if (targetArg && !isNaN(parseInt(targetArg, 10))) {
      count = Math.min(100, Math.max(1, parseInt(targetArg, 10)));
    }

    try {
      // Delete the command invocation message first if possible
      try {
        await rawMsg.delete().catch(() => {});
      } catch {}

      // Discord bulkDelete deletes up to 100 messages younger than 14 days
      const deleted = await channel.bulkDelete(count, true);
      const deletedCount = deleted.size || count;

      const replyNotice = `🧹 Deleted **${deletedCount}** messages from this channel.\n*(Note: Discord prevents bots from bulk-deleting messages older than 14 days. To delete 100% of all messages of any age, right-click the channel ➔ **Clone Channel**, then delete the old one!)*`;

      if (ctx.reply) {
        await ctx.reply(replyNotice);
      }
      ctx.log(`Cleared ${deletedCount} messages in channel ${channel.id}`, 'info');

      return {
        success: true,
        message: `Cleared ${deletedCount} messages`
      };
    } catch (err: any) {
      const errMsg = `⚠️ Failed to clear messages: ${err.message}. Make sure the bot has **"Manage Messages"** permission in Discord.`;
      if (ctx.reply) await ctx.reply(errMsg);
      ctx.log(errMsg, 'error');
      return { success: false, message: errMsg };
    }
  }
};
