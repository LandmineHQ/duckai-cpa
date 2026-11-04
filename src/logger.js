/**
 * Minimal leveled logger for duckai-cpa.
 *
 * Pure Node, no dependencies. Console output only; request logs / statistics are
 * kept by `store.js`. Kept deliberately small so the HTTP layer and admin API can
 * share it without pulling in extra packages.
 */

export const LOG_LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
});

export const LOG_LEVEL_NAMES = Object.freeze(['debug', 'info', 'warn', 'error', 'silent']);

const MAX_META_LENGTH = 4000;

function serializeMeta(meta) {
  if (meta === undefined) return '';
  try {
    if (meta instanceof Error) {
      return JSON.stringify({
        name: meta.name,
        message: meta.message,
        code: meta.code,
        status: meta.status,
        stack: typeof meta.stack === 'string' ? meta.stack.split('\n').slice(0, 6).join('\n') : undefined
      });
    }
    const seen = new WeakSet();
    const text = JSON.stringify(meta, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Error) return { name: value.name, message: value.message };
      return value;
    });
    if (text === undefined) return String(meta);
    return text.length > MAX_META_LENGTH ? `${text.slice(0, MAX_META_LENGTH)}…` : text;
  } catch {
    return String(meta);
  }
}

function normalizeLevel(level, fallback = 'info') {
  const value = String(level ?? '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, value) ? value : fallback;
}

/**
 * @param {{
 *   level?: string,
 *   name?: string,
 *   stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream
 * }} [options]
 */
export function createLogger(options = {}) {
  const name = options.name || 'duckai-cpa';
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  let level = normalizeLevel(options.level, 'info');

  const format = (lvl, message, meta) => {
    const ts = new Date().toISOString();
    const suffix = serializeMeta(meta);
    const text = message instanceof Error ? message.message : String(message);
    return `[${ts}] [${lvl.toUpperCase()}] [${name}] ${text}${suffix ? ` ${suffix}` : ''}`;
  };

  const emit = (lvl, message, meta) => {
    if (LOG_LEVELS[lvl] < LOG_LEVELS[level]) return;
    const line = format(lvl, message, meta);
    const stream = lvl === 'error' || lvl === 'warn' ? stderr : stdout;
    try {
      stream.write(`${line}\n`);
    } catch {
      // Never let logging break request handling.
    }
  };

  const logger = {
    get level() {
      return level;
    },
    setLevel(next) {
      level = normalizeLevel(next, level);
      return level;
    },
    isEnabled(lvl) {
      return LOG_LEVELS[normalizeLevel(lvl, 'silent')] >= LOG_LEVELS[level];
    },
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
    /** @returns {ReturnType<typeof createLogger>} */
    child(childName) {
      return createLogger({ level, name: `${name}:${childName}`, stdout, stderr });
    }
  };

  return logger;
}

/** A logger that stays quiet — used by tests and by createServer defaults. */
export function createNullLogger() {
  return createLogger({ level: 'silent', stdout: { write() {} }, stderr: { write() {} } });
}
