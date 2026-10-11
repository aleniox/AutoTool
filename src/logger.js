import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};

let stream = null;
function fileStream() {
  if (stream) return stream;
  try {
    fs.mkdirSync(config.paths.logs, { recursive: true });
    const file = path.join(config.paths.logs, `autotool-${new Date().toISOString().slice(0, 10)}.log`);
    stream = fs.createWriteStream(file, { flags: 'a' });
  } catch {
    stream = null;
  }
  return stream;
}

/** Callback de day log vao DB / SSE. Duoc set boi module db de tranh vong lap import. */
export const logSinks = new Set();

function emit(level, scope, message, extra) {
  if (LEVELS[level] < MIN) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${scope ? `(${scope}) ` : ''}${message}`;
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${COLORS[level] ?? ''}${line}${COLORS.reset}\n`);

  const fs2 = fileStream();
  if (fs2) fs2.write(`${line}\n`);

  for (const sink of logSinks) {
    try {
      sink({ ts, level, scope, message, ...(extra || {}) });
    } catch {
      /* sink loi thi bo qua, khong duoc lam chet app */
    }
  }
}

export function createLogger(scope = '') {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
    child: (sub) => createLogger(scope ? `${scope}:${sub}` : sub),
  };
}

export const logger = createLogger('app');
export default logger;
