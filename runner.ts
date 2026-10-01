import fs from 'fs';
import path from 'path';
import { execSync, spawn, ChildProcess } from 'child_process';

/**
 * Ensures node_modules exists and all packages are installed before running.
 */
function ensureDependenciesInstalled() {
  const nodeModulesPath = path.resolve(process.cwd(), 'node_modules');
  const expressPath = path.resolve(process.cwd(), 'node_modules', 'express');

  if (!fs.existsSync(nodeModulesPath) || !fs.existsSync(expressPath)) {
    try {
      execSync('npm install --legacy-peer-deps --no-audit --no-fund --silent', { stdio: 'ignore', cwd: process.cwd() });
    } catch {
      // ignore
    }
  }
}

ensureDependenciesInstalled();

let child: ChildProcess | null = null;
let restartCount = 0;
let lastRestartTime = Date.now();

function startProcess() {
  console.log(`[Supervisor] Launching Bot (Launch #${restartCount + 1})...`);

  // Target entry point: bot.ts (backend bot) or server.ts
  const entryScript = path.resolve(process.cwd(), 'bot.ts');
  const env = {
    ...process.env,
    MANAGED_BY_RUNNER: 'true'
  };

  child = spawn('npx', ['tsx', entryScript], {
    stdio: 'inherit',
    env
  });

  child.on('error', (err) => {
    console.error(`🚨 [SUPERVISOR] Child process failed to spawn:`, err);
  });

  child.on('exit', (code, signal) => {
    const now = Date.now();
    if (now - lastRestartTime > 60000) {
      restartCount = 0;
    }
    lastRestartTime = now;
    restartCount++;

    console.warn(`\n⚠️ [SUPERVISOR] Process exited with code ${code}, signal ${signal}.`);

    // Backoff delay if rapid crashes (1s to max 5s)
    const delay = Math.min(5000, 1000 * Math.min(restartCount, 5));
    console.log(`🔄 [SUPERVISOR] Auto-restarting in ${delay / 1000}s...`);

    setTimeout(() => {
      startProcess();
    }, delay);
  });
}

process.on('SIGINT', () => {
  console.log('\n🛑 [SUPERVISOR] SIGINT received, stopping child process...');
  if (child) child.kill('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 [SUPERVISOR] SIGTERM received, stopping child process...');
  if (child) child.kill('SIGTERM');
  process.exit(0);
});

startProcess();
