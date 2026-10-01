function getDateTimeString(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${hh}:${min}:${ss}`;
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

export const ConsoleLogger = {
  started(): void {
    process.stdout.write(`\n${getDateTimeString()} ${GREEN}Started${RESET}\n`);
  },

  updated(): void {
    process.stdout.write(`\n${getDateTimeString()} ${GREEN}updated${RESET}\n`);
  },

  restarted(): void {
    process.stdout.write(`\n${getDateTimeString()} ${GREEN}restarted${RESET}\n`);
  },

  stopped(): void {
    process.stdout.write(`\n${getDateTimeString()} ${GREEN}stoped.${RESET}\n`);
  },

  error(err: any, contextCause?: string): void {
    const rawMsg = typeof err === 'string' ? err : err?.message || String(err);
    const shortMsg = rawMsg.split('\n')[0].slice(0, 120);
    let cause = contextCause || '';
    if (!cause && err?.stack) {
      const stackLines = String(err.stack).split('\n');
      const atLine = stackLines.find((l) => l.trim().startsWith('at '));
      if (atLine) {
        cause = atLine.trim().replace(/^at\s+/, '');
      }
    }
    const causeSuffix = cause ? ` (cause: ${cause})` : '';
    process.stderr.write(`\n${getDateTimeString()} ${RED}${shortMsg}${causeSuffix}${RESET}\n`);
  }
};
