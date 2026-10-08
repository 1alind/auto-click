import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export function createControlButtons(isRunning: boolean = false): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();

  if (isRunning) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('btn_stop')
        .setLabel('Stop')
        .setEmoji('⏹️')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('btn_hold')
        .setLabel('Hold')
        .setEmoji('⏱️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('btn_fixac')
        .setLabel('Fixac')
        .setEmoji('🔧')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('btn_screenshot')
        .setLabel('Screen')
        .setEmoji('📸')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('btn_status')
        .setLabel('Status')
        .setEmoji('📊')
        .setStyle(ButtonStyle.Secondary)
    );
  } else {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('btn_start')
        .setLabel('Start')
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('btn_hold')
        .setLabel('Hold')
        .setEmoji('⏱️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('btn_fixac')
        .setLabel('Fixac')
        .setEmoji('🔧')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('btn_screenshot')
        .setLabel('Screen')
        .setEmoji('📸')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('btn_status')
        .setLabel('Status')
        .setEmoji('📊')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return row;
}

export function createControlButtonsJson(isRunning: boolean = false): any[] {
  return [createControlButtons(isRunning).toJSON()];
}
