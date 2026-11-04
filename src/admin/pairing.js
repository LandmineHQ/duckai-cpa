/**
 * v2.5 pairing support for the Admin API.
 *
 * - PairingStore: persists the *official DuckDuckGo recovery code* (separate from
 *   the local v2.2 extended recovery code) in `data/pairing.json` (mode 0600).
 * - PairingService: lazily creates duck-protocol's PairingHost, wires its
 *   `account.getRecoveryCode()` to the store and enforces one host at a time.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const PAIRING_FILE = 'pairing.json';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizePairingStatus(status) {
  if (!isPlainObject(status)) return null;
  return {
    state: typeof status.state === 'string' ? status.state : 'idle',
    channelId: status.channelId ?? null,
    peerChannelId: status.peerChannelId ?? null,
    peerName: status.peerName ?? null,
    peerKind: status.peerKind ?? null,
    peerUserId: status.peerUserId ?? null,
    recoveryUserId: status.recoveryUserId ?? null,
    // never echo the plaintext official recovery code over HTTP
    recoveryCodeReceived: status.recoveryCodeReceived === true,
    accountConflict: status.accountConflict === true,
    substate: status.substate ?? null,
    lastSeq: Number.isFinite(status.lastSeq) ? status.lastSeq : 0,
    messages: Array.isArray(status.messages)
      ? status.messages.map((message) => ({
          dir: message?.dir ?? null,
          type: message?.type ?? null,
          at: message?.at ?? null,
          ...(Number.isFinite(message?.seq) ? { seq: message.seq } : {}),
          ...(Number.isFinite(message?.httpStatus) ? { httpStatus: message.httpStatus } : {})
        }))
      : [],
    endReason: status.endReason ?? null,
    endDetail: status.endDetail ?? null,
    completedAs: status.completedAs ?? null,
    httpStatus: Number.isFinite(status.httpStatus) ? status.httpStatus : null,
    startedAt: status.startedAt ?? null,
    expiresAt: status.expiresAt ?? null,
    expiresInMs: Number.isFinite(status.expiresInMs)
      ? status.expiresInMs
      : Number.isFinite(status.expiresAt)
        ? Math.max(0, status.expiresAt - Date.now())
        : null,
    qrUrl: status.qrUrl ?? null,
    pairingCode: status.pairingCode ?? null,
    accountAvailable: status.accountAvailable === true,
    syncBase: status.syncBase ?? null
  };
}

/* ------------------------------------------------------------------ */
/* Official recovery code store                                        */
/* ------------------------------------------------------------------ */

export function createPairingStore({ dataDir, logger = null } = {}) {
  if (!dataDir) throw new Error('createPairingStore: dataDir is required');
  const filePath = path.join(dataDir, PAIRING_FILE);
  let state = { officialRecoveryCode: null, updatedAt: null, source: null };
  let loaded = false;
  let writeChain = Promise.resolve();

  async function ensureLoaded() {
    if (loaded) return;
    try {
      const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (isPlainObject(raw) && typeof raw.officialRecoveryCode === 'string' && raw.officialRecoveryCode.trim()) {
        state = {
          officialRecoveryCode: raw.officialRecoveryCode,
          updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
          // legacy pairing.json has no source: infer "pairing" for existing codes.
          // v2.17: keep "self" so "Sync This Device Only" accounts stay distinguishable.
          source:
            raw.source === 'manual' || raw.source === 'pairing' || raw.source === 'self'
              ? raw.source
              : 'pairing'
        };
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        logger?.warn?.('could not read pairing.json', { error: error.message });
      }
    }
    loaded = true;
  }

  async function persist() {
    writeChain = writeChain.then(async () => {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 }).catch(() => {});
      const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tempPath, filePath);
    });
    return writeChain;
  }

  const store = {
    filePath,

    async init() {
      await ensureLoaded();
      return store;
    },

    /** Internal use only (pairing host account hook). Never expose over HTTP. */
    async getRecoveryCode() {
      await ensureLoaded();
      return state.officialRecoveryCode || null;
    },

    async getStatus(options = {}) {
      await ensureLoaded();
      const code = state.officialRecoveryCode || '';
      const includeCode = options.includeCode === true;
      return {
        configured: Boolean(code),
        hasCode: Boolean(code),
        ...(includeCode ? { code: code || null } : {}),
        updatedAt: state.updatedAt,
        source: code ? state.source || 'manual' : null,
        // coarse hint kept for compatibility; full code only via includeCode.
        preview: code ? `${code.slice(0, 4)}…${code.slice(-4)}` : null,
        length: code ? code.length : 0
      };
    },

    async setRecoveryCode(code, { source = 'manual' } = {}) {
      if (typeof code !== 'string' || !code.trim()) {
        throw Object.assign(new Error('"code" must be a non-empty string'), { status: 400, code: 'invalid_request' });
      }
      if (code.length > 65536) {
        throw Object.assign(new Error('recovery code is too long (max 65536 chars)'), {
          status: 400,
          code: 'invalid_request'
        });
      }
      await ensureLoaded();
      state = {
        officialRecoveryCode: code.trim(),
        updatedAt: Date.now(),
        source: source === 'pairing' ? 'pairing' : source === 'self' ? 'self' : 'manual'
      };
      await persist();
      return store.getStatus();
    },

    async clearRecoveryCode() {
      await ensureLoaded();
      state = { officialRecoveryCode: null, updatedAt: Date.now(), source: null };
      await persist();
      return store.getStatus();
    },

    async close() {
      await writeChain.catch(() => {});
    }
  };
  return store;
}

/* ------------------------------------------------------------------ */
/* Pairing service                                                     */
/* ------------------------------------------------------------------ */

export function createPairingService({
  createPairingHost,
  pairingStore,
  proxyManager = null,
  logger = null,
  config = null,
  options = {}
} = {}) {
  if (typeof createPairingHost !== 'function') throw new Error('createPairingService: createPairingHost is required');
  if (!pairingStore) throw new Error('createPairingService: pairingStore is required');
  const overwriteAccount =
    options.overwriteAccount === true || config?.sync?.pairing?.overwriteAccount === true;
  let host = null;

  function isTerminal(status) {
    return ['completed', 'failed', 'timeout', 'idle'].includes(status?.state);
  }

  /** Recovery code of the *peer* account handed over during the last pairing (not persisted yet). */
  let pendingAccount = null;
  /** Cache of our own recovery code (service scope; `state` lives in createPairingStore). */
  let currentAccountCode = null;

  function userIdFromRecoveryCode(code) {
    if (typeof code !== 'string' || !code) return null;
    try {
      const payload = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'));
      const userId = payload?.recovery?.user_id;
      return typeof userId === 'string' && userId ? userId : null;
    } catch {
      return null;
    }
  }

  const account = {
    // Let duck-protocol detect `accountConflict` (peer has a different account than us).
    // NOTE: must stay synchronous — duck reads it as a plain property.
    get userId() {
      return userIdFromRecoveryCode(currentAccountCode);
    },
    async getRecoveryCode() {
      const code = await pairingStore.getRecoveryCode();
      currentAccountCode = code || null;
      if (!code) {
        const error = Object.assign(new Error('official DuckDuckGo recovery code is not configured'), {
          status: 400,
          code: 'recovery_code_unavailable'
        });
        throw error;
      }
      return code;
    }
  };

  return {
    get active() {
      return Boolean(host);
    },

    async start() {
      if (host && !isTerminal(host.status())) {
        const error = Object.assign(new Error('a pairing session is already in progress'), {
          status: 409,
          code: 'pairing_in_progress'
        });
        throw error;
      }
      if (host) {
        try {
          await host.stop('aborted');
        } catch {
          // ignore stale host shutdown errors
        }
        host = null;
      }
      currentAccountCode = await pairingStore.getRecoveryCode();
      host = await createPairingHost({
        proxyManager,
        logger,
        account,
        // v2.14: 默认「有账号就宣告可用」(available)。preferPeerAccount=true 时改为向对端索取码；
        // 双方都无账号/都索取会造成僵局，因此默认关闭，仅在明确要跟随手机账号时开启。
        preferPeerAccount: config?.sync?.pairing?.preferPeerAccount === true,
        ...options,
        onCompleted: (status) => {
          const finish = async () => {
            // v2.5 joiner mode: the phone (leader) sends its official DuckDuckGo
            // recovery code; persist it so subsequent sync/account flows work.
            const recoveryCode =
              status?.recoveryCode ??
              status?.recovery_code ??
              status?.recovery?.code ??
              status?.payload?.recoveryCode ??
              null;
            if (
              typeof recoveryCode === 'string' &&
              recoveryCode.trim() &&
              status?.completedAs !== 'host'
            ) {
              const code = recoveryCode.trim();
              // v2.16: "Sync only" mode never writes the recovery code to disk — it is kept in
              // memory for this process only, so a restart requires re-pairing.
              const syncMode =
                typeof options.getSyncMode === 'function'
                  ? await Promise.resolve(options.getSyncMode()).catch(() => 'backup')
                  : 'backup';
              if (syncMode === 'syncOnly') {
                currentAccountCode = code;
                logger?.info?.('[pairing] Sync-only mode: recovery code kept in memory only (not persisted)', {
                  peerName: status?.peerName ?? null,
                  recoveredUserId: status?.recoveryUserId ?? status?.peerUserId ?? null
                });
                if (typeof options.onCompleted === 'function') {
                  try {
                    await options.onCompleted(status);
                  } catch (error) {
                    logger?.warn?.('[pairing] onCompleted callback failed', { error: error.message });
                  }
                }
                return;
              }
              const existing = await pairingStore.getRecoveryCode();
              if (!existing) {
                await pairingStore.setRecoveryCode(code, { source: 'pairing' });
                currentAccountCode = code;
                logger?.info?.('[pairing] official recovery code received and persisted', {
                  peerName: status?.peerName ?? null,
                  peerUserId: status?.peerUserId ?? null,
                  completedAs: status?.completedAs ?? null,
                  codeLength: code.length
                });
              } else if (existing === code) {
                logger?.info?.('[pairing] official recovery code unchanged');
              } else if (overwriteAccount) {
                await pairingStore.setRecoveryCode(code, { source: 'pairing' });
                currentAccountCode = code;
                logger?.info?.('[pairing] official recovery code overwritten (sync.pairing.overwriteAccount=true)', {
                  peerName: status?.peerName ?? null,
                  recoveredUserId: status?.recoveryUserId ?? status?.peerUserId ?? null
                });
              } else {
                // Keep the existing account by default, but remember the peer's code so the user
                // can explicitly switch the gateway to the phone's account from the UI.
                pendingAccount = {
                  code,
                  userId: status?.recoveryUserId ?? status?.peerUserId ?? userIdFromRecoveryCode(code),
                  peerName: status?.peerName ?? null,
                  receivedAt: Date.now()
                };
                logger?.warn?.(
                  '[pairing] different official recovery code received but sync.pairing.overwriteAccount=false; kept existing code (pendingAccount remembered for explicit adopt)',
                  {
                    peerName: status?.peerName ?? null,
                    accountConflict: status?.accountConflict === true,
                    recoveredUserId: pendingAccount.userId
                  }
                );
              }
            }
            logger?.info?.('[pairing] completed', {
              state: status?.state,
              completedAs: status?.completedAs,
              endReason: status?.endReason,
              peerName: status?.peerName ?? null
            });
            if (typeof options.onCompleted === 'function') {
              try {
                await options.onCompleted(status);
              } catch (error) {
                logger?.warn?.('[pairing] onCompleted callback failed', { error: error.message });
              }
            }
          };
          // PairingHost does not await onCompleted; keep the promise handled.
          Promise.resolve()
            .then(finish)
            .catch((error) => logger?.warn?.('[pairing] onCompleted persistence failed', { error: error.message }));
        }
      });
      const status = host.status();
      const codeStatus = await pairingStore.getStatus();
      return {
        channelId: status.channelId,
        pairingCode: status.pairingCode,
        url: status.qrUrl ?? null,
        qrUrl: status.qrUrl ?? null,
        expiresAt: status.expiresAt ?? null,
        state: status.state,
        createdAt: status.startedAt ?? null,
        accountAvailable: codeStatus.configured === true
      };
    },

    async status() {
      if (!host) return null;
      const status = sanitizePairingStatus(host.status());
      const codeStatus = await pairingStore.getStatus();
      const ownUserId = userIdFromRecoveryCode(currentAccountCode);
      const peerUserId = status?.recoveryUserId || status?.peerUserId || null;
      // v2.15: 配对成功后若已采用对端账号，就不再是「账号冲突」，前端要显示成功而不是冲突。
      const accountMerged =
        status?.state === 'completed' && Boolean(peerUserId) && Boolean(ownUserId) && ownUserId === peerUserId;
      return {
        ...status,
        accountConflict: accountMerged ? false : status?.accountConflict === true,
        accountMerged,
        accountAvailable: codeStatus.configured === true,
        currentAccountUserId: ownUserId,
        // Peer account handed over during this pairing but not adopted yet (no plaintext code).
        pendingAccount: pendingAccount
          ? { userId: pendingAccount.userId, peerName: pendingAccount.peerName, receivedAt: pendingAccount.receivedAt }
          : null
      };
    },

    /**
     * Adopt the peer account received during the last pairing: switch the gateway's official
     * recovery code to the phone's account (used when the user explicitly wants to merge the
     * gateway into the phone's account instead of the other way around).
     */
    async adoptPendingAccount() {
      if (!pendingAccount || !pendingAccount.code) {
        const error = Object.assign(new Error('no pending account from a pairing session'), {
          status: 400,
          code: 'no_pending_account'
        });
        throw error;
      }
      const { code, userId } = pendingAccount;
      await pairingStore.setRecoveryCode(code, { source: 'pairing' });
      currentAccountCode = code;
      pendingAccount = null;
      if (host) {
        try {
          await host.stop('aborted');
        } catch {
          // ignore: session already finished
        }
        host = null;
      }
      logger?.info?.('[pairing] adopted peer account', { userId });
      return { ok: true, accountUserId: userId, codeStatus: await pairingStore.getStatus() };
    },

    async stop(reason = 'aborted') {
      if (!host) return null;
      try {
        await host.stop(reason);
      } finally {
        const status = sanitizePairingStatus(host.status());
        host = null;
        return status;
      }
    },

    async close() {
      if (!host) return;
      try {
        await host.stop('aborted');
      } catch {
        // ignore
      }
      host = null;
    },

    pairingStore
  };
}

export { sanitizePairingStatus };
