/**
 * Global FIFO / RPS queue for duck.ai upstream calls (v2).
 *
 * Every upstream request (v1 chat/responses/images and admin session tests) must
 * pass through one queue instance. Behaviour is driven by `config.upstream` and
 * reads the live config on every enqueue/pump, so `PUT /admin/api/config` takes
 * effect immediately (no restart).
 *
 *   - maxConcurrent : how many upstream calls may run at the same time
 *   - rps           : maximum number of starts per second (start interval ≥ 1000/rps ms)
 *   - queueLimit    : maximum waiting requests; overflow → 429 queue_full
 *   - queueTimeoutMs: max time a request may wait; exceeded → 429 queue_timeout
 */

const QUEUE_ERROR_DEFAULT_RETRY_AFTER = 1;

export class QueueError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, retryAfter?: number }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'QueueError';
    this.code = meta.code || 'queue_full';
    this.status = meta.status ?? 429;
    this.retryAfter = Math.max(1, Math.trunc(meta.retryAfter ?? QUEUE_ERROR_DEFAULT_RETRY_AFTER));
  }
}

function abortError() {
  const error = new Error('request aborted');
  error.name = 'AbortError';
  return error;
}

function readSettings(config) {
  const source = config?.upstream && typeof config.upstream === 'object' ? config.upstream : {};
  const rpsNumber = Number(source.rps);
  const concurrencyNumber = Number(source.maxConcurrent);
  const limitNumber = Number(source.queueLimit);
  const timeoutNumber = Number(source.queueTimeoutMs);
  return {
    rps: Number.isFinite(rpsNumber) && rpsNumber > 0 ? Math.min(100, rpsNumber) : 1,
    maxConcurrent:
      Number.isFinite(concurrencyNumber) && concurrencyNumber >= 1 ? Math.min(16, Math.trunc(concurrencyNumber)) : 1,
    queueLimit: Number.isFinite(limitNumber) && limitNumber >= 0 ? Math.min(1000, Math.trunc(limitNumber)) : 50,
    queueTimeoutMs:
      Number.isFinite(timeoutNumber) && timeoutNumber >= 1000 ? Math.min(600000, Math.trunc(timeoutNumber)) : 300000
  };
}

/**
 * @param {{
 *   config: Record<string, any>,
 *   logger?: {warn?: Function, debug?: Function}
 * }} options
 */
export function createUpstreamQueue(options = {}) {
  const { config, logger } = options;
  if (!config) throw new Error('createUpstreamQueue: config is required');

  /** @type {Array<Record<string, any>>} FIFO waiters */
  const waiters = [];
  let active = 0;
  let lastStartAt = null;
  let waitTotalMs = 0;
  let startedCount = 0;
  let pumpTimer = null;
  let closed = false;

  function currentRetryAfter(settings) {
    const waiting = Math.max(1, waiters.length + 1);
    return Math.max(1, Math.ceil(waiting / settings.rps));
  }

  function canStartNow(settings) {
    if (active >= settings.maxConcurrent) return false;
    if (lastStartAt === null) return true;
    return Date.now() - lastStartAt >= 1000 / settings.rps;
  }

  function clearPumpTimer() {
    if (!pumpTimer) return;
    clearTimeout(pumpTimer);
    pumpTimer = null;
  }

  function schedulePump(delayMs) {
    clearPumpTimer();
    if (closed) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pump();
    }, Math.max(1, delayMs));
    pumpTimer.unref?.();
  }

  function detachWaiter(waiter) {
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = null;
    }
    if (waiter.abortHandler && waiter.signal) {
      try {
        waiter.signal.removeEventListener('abort', waiter.abortHandler);
      } catch {
        // ignore
      }
      waiter.abortHandler = null;
    }
  }

  function removeWaiter(waiter) {
    const index = waiters.indexOf(waiter);
    if (index !== -1) waiters.splice(index, 1);
  }

  function startWaiter(waiter, startedAt) {
    detachWaiter(waiter);
    active += 1;
    lastStartAt = startedAt;
    const queueWaitMs = Math.max(0, startedAt - waiter.enqueuedAt);
    waitTotalMs += queueWaitMs;
    startedCount += 1;
    if (typeof waiter.onStart === 'function') {
      try {
        waiter.onStart({ queueWaitMs, startedAt });
      } catch (error) {
        logger?.warn?.('upstream queue onStart callback failed', { error: error?.message });
      }
    }
    Promise.resolve()
      .then(() => waiter.task())
      .then(
        (value) => {
          active = Math.max(0, active - 1);
          pump();
          waiter.resolve(value);
        },
        (error) => {
          active = Math.max(0, active - 1);
          pump();
          waiter.reject(error);
        }
      );
  }

  function pump() {
    if (closed) return;
    clearPumpTimer();
    const settings = readSettings(config);
    while (waiters.length > 0 && active < settings.maxConcurrent) {
      const now = Date.now();
      const interval = 1000 / settings.rps;
      const nextAllowedAt = lastStartAt === null ? now : lastStartAt + interval;
      if (now < nextAllowedAt) {
        schedulePump(nextAllowedAt - now);
        return;
      }
      const waiter = waiters.shift();
      if (!waiter) return;
      startWaiter(waiter, now);
    }
  }

  const queue = {
    /**
     * Enqueue one upstream task.
     * @template T
     * @param {() => Promise<T>|T} task
     * @param {{ signal?: AbortSignal, onStart?: (info: {queueWaitMs: number, startedAt: number}) => void, meta?: Record<string, any> }} [runOptions]
     * @returns {Promise<T>}
     */
    run(task, runOptions = {}) {
      if (typeof task !== 'function') return Promise.reject(new TypeError('queue.run expects a function'));
      if (closed) {
        return Promise.reject(new QueueError('upstream queue is shutting down', { code: 'queue_timeout', status: 503 }));
      }
      const { signal, onStart } = runOptions;
      if (signal?.aborted) return Promise.reject(abortError());

      const settings = readSettings(config);
      const immediate = waiters.length === 0 && canStartNow(settings);
      if (!immediate && waiters.length >= settings.queueLimit) {
        return Promise.reject(
          new QueueError(
            `Upstream queue is full (${waiters.length}/${settings.queueLimit}); retry later`,
            { code: 'queue_full', status: 429, retryAfter: currentRetryAfter(settings) }
          )
        );
      }

      return new Promise((resolve, reject) => {
        const waiter = {
          task,
          onStart,
          enqueuedAt: Date.now(),
          resolve,
          reject,
          signal: signal || null,
          timer: null,
          abortHandler: null,
          meta: runOptions.meta || null
        };

        waiter.timer = setTimeout(() => {
          if (!waiters.includes(waiter)) return;
          removeWaiter(waiter);
          detachWaiter(waiter);
          const live = readSettings(config);
          reject(
            new QueueError(
              `Upstream queue wait timed out after ${settings.queueTimeoutMs}ms`,
              { code: 'queue_timeout', status: 429, retryAfter: currentRetryAfter(live) }
            )
          );
        }, settings.queueTimeoutMs);
        waiter.timer.unref?.();

        if (signal) {
          waiter.abortHandler = () => {
            if (!waiters.includes(waiter)) return;
            removeWaiter(waiter);
            detachWaiter(waiter);
            reject(abortError());
          };
          signal.addEventListener('abort', waiter.abortHandler, { once: true });
        }

        waiters.push(waiter);
        pump();
      });
    },

    /** Queue snapshot for /admin/api/overview → upstream.queue. */
    snapshot() {
      const settings = readSettings(config);
      return {
        waiting: waiters.length,
        inFlight: active,
        rps: settings.rps,
        maxConcurrent: settings.maxConcurrent,
        limit: settings.queueLimit,
        avgWaitMs: startedCount > 0 ? Math.round(waitTotalMs / startedCount) : 0,
        lastStartAt
      };
    },

    /** Reject every queued waiter (graceful shutdown). */
    close() {
      closed = true;
      clearPumpTimer();
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        detachWaiter(waiter);
        waiter.reject(new QueueError('upstream queue is shutting down', { code: 'queue_timeout', status: 503 }));
      }
    },

    get waiting() {
      return waiters.length;
    },
    get inFlight() {
      return active;
    }
  };

  return queue;
}
