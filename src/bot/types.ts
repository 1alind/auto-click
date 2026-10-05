export interface BotConfig {
  discordToken: string;
  webhookUrl: string;
  prefix: string;
  adbSerial: string;
  adbHost: string;
  matchThreshold: number; // 0.0 - 1.0 (e.g. 0.75)
  scales: number[]; // e.g. [0.5, 0.65, 0.8, 1.0, 1.25, 1.5, 1.8, 2.0]
  autoStartBot: boolean;
  autoUpdate: boolean; // auto check github and pull
  githubRepo?: string; // e.g. "owner/repo" or git remote
  githubToken?: string; // GitHub Personal Access Token (for private repos)
  updateCheckIntervalMinutes: number; // e.g. 15 minutes
  autoRestartOnCrash: boolean;
  useSimulatorFallback?: boolean;
  geminiApiKey?: string;
  geminiModel?: string;
  aiRescueEnabled?: boolean;
}

export interface MatchBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MatchResult {
  found: boolean;
  score: number;
  box: MatchBoundingBox;
  scale: number;
  targetPoint: { x: number; y: number };
  executionTimeMs: number;
  visualDebugBase64?: string;
}

export interface StepLog {
  step: number;
  title: string;
  description: string;
  timestamp: number;
  data?: any;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface CommandContext {
  commandName: string;
  args: string[];
  author?: {
    id: string;
    tag: string;
    username: string;
  };
  channelId?: string;
  discordMessage?: any;
  reply?: (message: string) => Promise<any>;
  log: (message: string, level?: 'info' | 'warn' | 'error' | 'step', meta?: any) => void;
  notifyStep?: (step: number, title: string, description: string, status?: 'running' | 'completed' | 'failed', data?: any) => void;
}

export interface CommandResult {
  success: boolean;
  message: string;
  data?: any;
  steps?: StepLog[];
}

export interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  aliases?: string[];
  execute: (ctx: CommandContext) => Promise<CommandResult>;
}

export interface BotLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'step' | 'command';
  message: string;
  data?: any;
}
