import { CommandDefinition, CommandContext, CommandResult, StepLog } from '../types';
import { TemplateMatcher } from '../matcher';
import { RefImageManager } from '../refImage';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const findCommand: CommandDefinition = {
  name: 'find',
  description: 'Executes the 13-step ADB automated visual detection and crop flow.',
  usage: 'find [optional: debug]',

  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const steps: StepLog[] = [];
    const recordStep = (
      stepNum: number,
      title: string,
      description: string,
      status: 'running' | 'completed' | 'failed' = 'completed',
      data?: any
    ) => {
      const stepEntry: StepLog = {
        step: stepNum,
        title,
        description,
        timestamp: Date.now(),
        status,
        data
      };
      steps.push(stepEntry);
      ctx.log(`[Step ${stepNum}/13] ${title}: ${description}`, 'step', data);
      if (ctx.notifyStep) {
        ctx.notifyStep(stepNum, title, description, status, data);
      }
    };

    let progressMsgId: string | undefined;
    const { MacroManager } = await import('../macroManager');

    // If another `find` is already running, wait for it to finish
    if (MacroManager.isFindRunning()) {
      await MacroManager.waitForFind();
    }

    // Lock `find` so NO other command or updater can interrupt it until it finishes
    MacroManager.beginFind();

    try {
      // If `start` (or another macro) is currently running, wait for it to finish its cycle right before step 1
      if (MacroManager.getRunningMacro()) {
        ctx.log('⏳ Waiting for running macro to reach boundary before Step 1...', 'info');
        await MacroManager.stopAllAndWait();
      }

      ctx.log('🚀 Starting automation flow: "find"...', 'info');

      const { botManager } = await import('../botManager');
      const adb = botManager.getAdbController();
      const discord = botManager.getDiscordBot();

      const updateProgress = async (text: string) => {
        if (!discord.isConnected()) return;
        try {
          const res = await discord.updateDashboard({ content: text });
          if (res.success && res.messageId) {
            progressMsgId = res.messageId;
          }
        } catch {
          // ignore transient progress update errors
        }
      };

      // Step 1: Randomly tap X=227–766, Y=2326–2387 using ADB
      await updateProgress('find: step 1');
      const tap1MinX = 227, tap1MaxX = 766, tap1MinY = 2326, tap1MaxY = 2387;
      const tap1Result = await adb.tapRandomRange(tap1MinX, tap1MaxX, tap1MinY, tap1MaxY);
      recordStep(
        1,
        'Random ADB Tap',
        `Tapped point (${tap1Result.x}, ${tap1Result.y}) in range X=[${tap1MinX}..${tap1MaxX}], Y=[${tap1MinY}..${tap1MaxY}]`,
        'completed',
        { coords: { x: tap1Result.x, y: tap1Result.y }, isSimulated: tap1Result.isSimulated }
      );

      // Step 2: Wait 2 seconds
      recordStep(2, 'Wait', 'Waiting 2,000ms (2 seconds)...', 'running');
      await sleep(2000);
      steps[steps.length - 1].status = 'completed';

      // Step 3: Randomly tap X=578–763, Y=230–327
      await updateProgress('find: step 2');
      const tap2MinX = 578, tap2MaxX = 763, tap2MinY = 230, tap2MaxY = 327;
      const tap2Result = await adb.tapRandomRange(tap2MinX, tap2MaxX, tap2MinY, tap2MaxY);
      recordStep(
        3,
        'Random ADB Tap',
        `Tapped point (${tap2Result.x}, ${tap2Result.y}) in range X=[${tap2MinX}..${tap2MaxX}], Y=[${tap2MinY}..${tap2MaxY}]`,
        'completed',
        { coords: { x: tap2Result.x, y: tap2Result.y }, isSimulated: tap2Result.isSimulated }
      );

      // Step 4: Wait 3 seconds for list/pfps to load
      recordStep(4, 'Wait', 'Waiting 3,000ms (3 seconds)...', 'running');
      await sleep(3000);
      steps[steps.length - 1].status = 'completed';

      // Step 5: Take a raw Android screen capture in RAM & search for pfp.png
      await updateProgress('find: step 3 searching for pfp.png');
      recordStep(5, 'Capture Screenshot', 'Capturing raw device screen in RAM via ADB...', 'running');
      const rawScreen1 = await adb.screencapRaw();
      steps[steps.length - 1].status = 'completed';
      steps[steps.length - 1].data = { screenshotSize: rawScreen1.data.length };

      // Step 6 & 7: Visually locate pfp.png inside the raw screen within region X:79-220, Y:523-1721
      const refPath = await RefImageManager.ensureRefImage();
      const searchRegion = { minX: 79, maxX: 220, minY: 523, maxY: 1721 };
      recordStep(
        6,
        'Locate Reference Image',
        `Searching for pfp.png (${refPath}) in area X=[79..220], Y=[523..1721]...`,
        'running'
      );
      const config = botManager.getConfig();
      const matchResult = await TemplateMatcher.matchRaw(rawScreen1, refPath, {
        scales: [0.7, 0.85, 1.0, 1.15, 1.3],
        threshold: config.matchThreshold,
        region: searchRegion
      });

      steps[steps.length - 1].status = matchResult.found ? 'completed' : 'failed';
      steps[steps.length - 1].data = {
        found: matchResult.found,
        score: matchResult.score,
        scale: matchResult.scale,
        box: matchResult.box,
        targetPoint: matchResult.targetPoint,
        executionTimeMs: matchResult.executionTimeMs,
        debugOverlay: matchResult.visualDebugBase64
      };

      if (!matchResult.found) {
        const errorMsg = `❌ Image "pfp.png" NOT found in find step 3! Score: ${(matchResult.score * 100).toFixed(1)}% (< ${(config.matchThreshold * 100).toFixed(0)}%). Stopping script.`;
        ctx.log(errorMsg, 'error');

        // Crop the search area directly from the raw screen buffer and send to Discord
        try {
          if (discord.isConnected()) {
            const croppedBuffer = await TemplateMatcher.cropRawToPng(rawScreen1, searchRegion);
            await discord.updateDashboard({
              content: errorMsg,
              fileBuffer: croppedBuffer,
              fileName: `find_not_found_pfp.png`
            });
          }
        } catch (err: any) {
          ctx.log(`Failed to crop or send error image to Discord: ${err.message}`, 'warn');
        }

        MacroManager.endFind();
        return { success: false, message: errorMsg, steps };
      } else {
        ctx.log(
          `🎯 Match successful! Confidence: ${(matchResult.score * 100).toFixed(1)}% at [X:${matchResult.box.x}, Y:${matchResult.box.y}, W:${matchResult.box.width}, H:${matchResult.box.height}] scale: ${matchResult.scale}x in ${matchResult.executionTimeMs}ms`,
          'info'
        );
      }

      // Step 8: Click a random point inside the detected image area
      const tapTargetX = matchResult.targetPoint.x;
      const tapTargetY = matchResult.targetPoint.y;
      const tapMatchResult = await adb.tap(tapTargetX, tapTargetY);
      await updateProgress('find: step 3 clicked pfp.png');
      recordStep(
        8,
        'Click Matched Target Area',
        `Tapped random point (${tapTargetX}, ${tapTargetY}) inside detected area [X:${matchResult.box.x}..${matchResult.box.x + matchResult.box.width}, Y:${matchResult.box.y}..${matchResult.box.y + matchResult.box.height}]`,
        'completed',
        { coords: { x: tapTargetX, y: tapTargetY }, isSimulated: tapMatchResult.isSimulated }
      );

      // Step 9: Wait 3.5 seconds for profile/modal to load
      recordStep(9, 'Wait', 'Waiting 3,500ms (3.5 seconds)...', 'running');
      await sleep(3500);
      steps[steps.length - 1].status = 'completed';

      // Step 10: Randomly tap X=255–342, Y=2116–2156
      await updateProgress('find: step 4');
      const tap3MinX = 255, tap3MaxX = 342, tap3MinY = 2116, tap3MaxY = 2156;
      const tap3Result = await adb.tapRandomRange(tap3MinX, tap3MaxX, tap3MinY, tap3MaxY);
      recordStep(
        10,
        'Random ADB Tap',
        `Tapped point (${tap3Result.x}, ${tap3Result.y}) in range X=[${tap3MinX}..${tap3MaxX}], Y=[${tap3MinY}..${tap3MaxY}]`,
        'completed',
        { coords: { x: tap3Result.x, y: tap3Result.y }, isSimulated: tap3Result.isSimulated }
      );

      // Wait 3 seconds for screen transition after Step 10 tap before capturing the new screenshot
      await sleep(3000);

      // Step 11: Take another raw screenshot in RAM
      await updateProgress('find: step 5 cropping screenshot');
      recordStep(11, 'Capture Second Screenshot', 'Capturing post-action raw screen in RAM via ADB...', 'running');
      const rawScreen2 = await adb.screencapRaw();
      steps[steps.length - 1].status = 'completed';
      steps[steps.length - 1].data = { screenshotSize: rawScreen2.data.length };

      // Step 12: Crop exactly 150x150 pixels from the center of the raw screenshot
      recordStep(
        12,
        'Crop 150x150 Center',
        'Extracting exact 150x150 pixels bounding box from the center coordinates...',
        'running'
      );
      const croppedBuffer = await TemplateMatcher.cropRawCenterToPng(rawScreen2, 150, 150);
      const croppedBase64 = `data:image/png;base64,${croppedBuffer.toString('base64')}`;
      steps[steps.length - 1].status = 'completed';
      steps[steps.length - 1].data = {
        croppedSize: croppedBuffer.length,
        width: 150,
        height: 150,
        preview: croppedBase64
      };

      // Step 13: Update the existing Discord webhook message (or send if no messageId) with the 150x150 cropped image
      recordStep(
        13,
        'Dispatch Discord Webhook',
        'Updating Discord webhook message with 150x150 cropped center image...',
        'running'
      );

      const markdownContent = `-# **found** *(${(matchResult.score * 100).toFixed(0)}%)*`;

      let webhookStatus = 'Discord Bot updated successfully';
      if (discord.isConnected()) {
        const fileName = `cropped_${Date.now()}.png`;
        const sendResult = await discord.updateDashboard({
          content: markdownContent,
          fileBuffer: croppedBuffer,
          fileName
        });

        if (!sendResult.success) {
          webhookStatus = `Discord delivery warning: ${sendResult.error}`;
          ctx.log(webhookStatus, 'warn');
        } else {
          ctx.log('✅ Discord message updated with 150x150 image on Discord!', 'info');
        }
      } else {
        webhookStatus = 'Discord Bot not connected';
        ctx.log(`⚠️ ${webhookStatus}. Image captured and preserved in memory.`, 'warn');
      }

      steps[steps.length - 1].status = 'completed';
      steps[steps.length - 1].data = { webhookStatus };

      return {
        success: true,
        message: 'found',
        data: {
          matchResult,
          tap1: tap1Result,
          tap2: tap2Result,
          tap3: tap3Result,
          croppedBase64,
          debugOverlay: matchResult.visualDebugBase64
        },
        steps
      };
    } catch (err: any) {
      const errorMsg = `error: ${err.message}`;
      ctx.log(errorMsg, 'error', { stack: err.stack });
      if (ctx.reply) {
        await ctx.reply(errorMsg);
      }
      return {
        success: false,
        message: errorMsg,
        steps
      };
    } finally {
      MacroManager.endFind();
    }
  }
};
