/**
 * Duck.ai SSE parsing + event normalization (v2 strict).
 *
 * Wire format (verified 2026-11-01, cross-checked against the duck.ai web bundle):
 *   - Each frame is one `data: <payload>` line; the bundle itself consumes frames line-by-line.
 *   - `<payload>` is either JSON (one event object) or a pseudo marker:
 *       `[PING]`, `[CHAT_TITLE:<title>]`, `[DONE]` optionally followed by extra markers
 *       (`[FIXED_COST_WINDOW_USAGE:...]`, `[SUMMARY_REFRESH_HINT:...]`, `[SUMMARY_INVALID]`,
 *       `[ADS:...]`, `[LIMIT_ACCOUNT]`, `[LIMIT_ENTITY]`, `[LIMIT_CONVERSATION]`,
 *       `[LIMIT_IMAGE_GENERATIONS]`, `[STOP_REASON:<reason>]`, `[WARN_CONVERSATION_LIMIT:<n>]`).
 *   - Marker regexes are matched anywhere inside the frame (the upstream appends them to the
 *     `[DONE]` line), which is why exact string equality is not enough.
 *
 * Known SSE `role` values (from the bundle's frame switch / whitelist):
 *   `assistant` (or absent role with `message`), `reasoning`, `tool-invocation`, `source`,
 *   `generated-image`, `partial-image`, `ui-component`, `refusal`, `image-validated`,
 *   `continuation`, `skill-references`.
 *
 * Strict mode (`strict: true`) turns protocol deviations into `SSEProtocolError`:
 *   invalid JSON frame, unknown role, unknown normalized type, `action:"error"` frame.
 * The client aborts the upstream request when this happens and rethrows as `DuckError`.
 */

/** Matches inline citation markers embedded in assistant text: `<citation src="1,3"></citation>`. */
export const CITATION_MARKER_RE = /<citation\s+src="([^"]*)"\s*><\/citation>/gi;

/** SSE roles the upstream is allowed to send (browser bundle whitelist + implicit assistant text). */
export const KNOWN_SSE_ROLES = new Set([
  'assistant',
  'reasoning',
  'tool-invocation',
  'source',
  'generated-image',
  'partial-image',
  'ui-component',
  'refusal',
  'image-validated',
  'continuation',
  'skill-references'
]);

/**
 * Normalized event types. Anything else is a strict-mode violation.
 * `text-empty` is produced when an assistant frame carries no text (allowed: stream keep-alive frames).
 */
export const KNOWN_EVENT_TYPES = new Set([
  'text',
  'text-empty',
  'reasoning',
  'tool-call',
  'tool-result',
  'tool-invocation',
  'source',
  'ui-component',
  'image',
  'image-partial',
  'refusal',
  'image-validated',
  'continuation',
  'skill-references',
  'limit',
  'stop-reason',
  'conversation-limit-warning',
  'quota',
  'ad-window',
  'summary-refresh-hint',
  'summary-invalid',
  'title',
  'ping',
  'done',
  'error'
]);

/**
 * Protocol-level SSE error. The client converts this into `DuckError` and aborts the upstream request.
 */
export class SSEProtocolError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, retriable?: boolean, eventIndex?: number|null, snippet?: string|null, cause?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'SSEProtocolError';
    this.code = meta.code || 'upstream_protocol_mismatch';
    this.status = meta.status ?? 502;
    // `undefined` means "let the caller decide from the mapped error code".
    this.retriable = meta.retriable === undefined ? undefined : Boolean(meta.retriable);
    this.eventIndex = meta.eventIndex ?? null;
    this.snippet = meta.snippet ?? null;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

/**
 * Redact potentially sensitive / huge payloads before storing them in errors or logs.
 * - base64 image blobs → `<b64>`
 * - moderation tokens / long tokens → `<redacted>`
 * - truncates to `maxLength` characters
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function redactSnippet(value, maxLength = 300) {
  let text;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (!text) return '';
  text = text
    .replace(/("(?:b64Image|b64|base64Data)"\s*:\s*")[A-Za-z0-9+/=]{64,}"/g, '$1<b64>"')
    .replace(/("(?:result|text|content)"\s*:\s*")[A-Za-z0-9+/=]{120,}"/g, '$1<b64>"')
    .replace(/("moderationToken"\s*:\s*")[^"]{8,}"/g, '$1<redacted>"')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…(truncated)` : text;
}

/**
 * Parse one SSE line.
 * @param {string} line
 * @returns {{ field: string, value: string } | null}
 */
export function parseSSELine(line) {
  if (!line) return null;
  if (line.startsWith(':')) return null; // comment / keep-alive
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const field = line.slice(0, colon);
  if (field !== 'data' && field !== 'event' && field !== 'id' && field !== 'retry') return null;
  let value = line.slice(colon + 1);
  if (value.startsWith(' ')) value = value.slice(1);
  return { field, value };
}

/**
 * Incremental SSE line parser over a WHATWG `ReadableStream` body.
 * Yields `{ field, value }` records; only `data:` records are meaningful for duck.ai.
 * @param {ReadableStream<Uint8Array>} body
 */
export async function* readSSEStream(body) {
  if (!body || typeof body.getReader !== 'function') {
    throw new SSEProtocolError('SSE stream is not readable (missing response body)', {
      code: 'upstream_protocol_mismatch',
      status: 502
    });
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        const record = parseSSELine(line);
        if (record) yield record;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const record = parseSSELine(buffer.replace(/\r$/, ''));
      if (record) yield record;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Best-effort JSON parse for upstream fields that are stringified JSON (`toolArguments`).
 * @param {unknown} value
 * @returns {unknown}
 */
export function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

/** @param {string} value @returns {any} */
function decodeMarkerPayload(value) {
  try {
    return JSON.parse(decodeURIComponent(String(value || '')));
  } catch {
    return null;
  }
}

/**
 * Parse the `[DONE]` frame including its trailing pseudo markers.
 * @param {string} data
 * @returns {Array<Record<string, any>>}
 */
export function parseDoneFrame(data) {
  const events = [{ type: 'done' }];

  for (const match of data.matchAll(/\[FIXED_COST_WINDOW_USAGE:([^\]]+)\]/g)) {
    const payload = decodeMarkerPayload(match[1]);
    const windows = payload && Array.isArray(payload.windows) ? payload.windows : null;
    if (windows) events.push({ type: 'quota', windows, raw: payload });
  }
  for (const match of data.matchAll(/\[SUMMARY_REFRESH_HINT:([^\]]+)\]/g)) {
    const payload = decodeMarkerPayload(match[1]);
    if (payload) events.push({ type: 'summary-refresh-hint', hint: payload });
  }
  if (data.includes('[SUMMARY_INVALID]')) events.push({ type: 'summary-invalid' });
  for (const match of data.matchAll(/\[ADS:([^\]]+)\]/g)) {
    const payload = decodeMarkerPayload(match[1]);
    if (payload) events.push({ type: 'ad-window', payload });
  }
  if (data.includes('[LIMIT_ACCOUNT]')) events.push({ type: 'limit', code: 'ERR_ACCOUNT_LIMIT', scope: 'account' });
  if (data.includes('[LIMIT_ENTITY]')) events.push({ type: 'limit', code: 'ERR_USER_LIMIT', scope: 'entity' });
  if (data.includes('[LIMIT_CONVERSATION]')) events.push({ type: 'limit', code: 'ERR_CONVERSATION_LIMIT', scope: 'conversation' });
  if (data.includes('[LIMIT_IMAGE_GENERATIONS]')) events.push({ type: 'limit', code: 'ERR_IMAGE_GENERATION_LIMIT', scope: 'image' });
  for (const match of data.matchAll(/\[STOP_REASON:(\w+)\]/g)) events.push({ type: 'stop-reason', reason: match[1] });
  for (const match of data.matchAll(/\[WARN_CONVERSATION_LIMIT:(\d+)\]/g)) {
    events.push({ type: 'conversation-limit-warning', percent: Number(match[1]) });
  }
  return events;
}

/**
 * Normalize one SSE payload string into zero or more typed events.
 * @param {string} payload  the `data:` value (already trimmed of the SSE field name)
 * @returns {Array<Record<string, any>>}
 */
export function normalizeSSEPayload(payload) {
  const data = String(payload || '').trim();
  if (!data) return [];
  if (/\[PING\]/.test(data)) return [{ type: 'ping' }];
  const title = data.match(/\[CHAT_TITLE:(.*?)\]/);
  if (title) return [{ type: 'title', title: title[1] }];
  if (/\[DONE\]/.test(data)) return parseDoneFrame(data);
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [{ type: 'unknown', raw: data }];
  }
  if (Array.isArray(parsed)) {
    // The upstream sends one object per frame; an array is not a valid frame.
    return [{ type: 'unknown', raw: data }];
  }
  return normalizeUpstreamEvent(parsed);
}

/**
 * Map one raw upstream JSON event to one normalized event.
 * @param {Record<string, any>} raw
 * @returns {Array<Record<string, any>>}
 */
export function normalizeUpstreamEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [{ type: 'unknown-event', raw }];
  const role = raw.role;
  const state = raw.state;

  if (raw.action === 'error' || (typeof raw.type === 'string' && raw.type.startsWith('ERR_'))) {
    return [
      {
        type: 'error',
        status: raw.status,
        code: raw.type || raw.overrideCode || 'ERR_UNKNOWN',
        message: raw.message || raw.type || 'upstream error',
        retriable: raw.retriable,
        supportCode: raw.supportCode,
        overrideCode: raw.overrideCode,
        reason: raw.r,
        challengeData: raw.cd || null,
        fixedCostWindowUsage: raw.fixedCostWindowUsage || null,
        raw
      }
    ];
  }

  if (role === 'continuation') {
    return [
      {
        type: 'continuation',
        action: raw.action || null,
        token: raw.token || null,
        pendingActions: Array.isArray(raw.pendingActions) ? raw.pendingActions : [],
        replayPolicy: raw.replayPolicy || null,
        consentDecisions: raw.consentDecisions || null,
        responses: Array.isArray(raw.responses) ? raw.responses : null,
        raw
      }
    ];
  }

  if (role === 'skill-references') {
    return [{ type: 'skill-references', action: raw.action || null, skills: Array.isArray(raw.skills) ? raw.skills : [], raw }];
  }

  if (role === 'assistant' || role === undefined || role === null) {
    if (typeof raw.message === 'string' && raw.message.length) {
      return [{ type: 'text', text: raw.message, raw }];
    }
    if (Array.isArray(raw.parts)) {
      const text = raw.parts
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
      if (text) return [{ type: 'text', text, raw }];
    }
    return [{ type: 'text-empty', raw }];
  }

  if (role === 'reasoning') {
    let text = '';
    // v2.19: the upstream "done" frame may repeat the ENTIRE reasoning in summaryText; emitting it
    // as a delta duplicated everything that was already streamed via text-delta. Keep it as
    // finalText (fallback only when nothing was streamed) instead of appending it.
    let finalText = '';
    if (state === 'text-delta' && typeof raw.text === 'string') text = raw.text;
    else if (state === 'done') {
      if (Array.isArray(raw.summaryText)) finalText = raw.summaryText.join('');
      else if (typeof raw.summaryText === 'string') finalText = raw.summaryText;
    } else if (typeof raw.text === 'string') text = raw.text;
    else if (typeof raw.message === 'string') text = raw.message;
    return [
      {
        type: 'reasoning',
        state: state || null,
        text,
        finalText,
        // Free/anonymous tier may send only an encrypted JWE blob (no plaintext reasoning).
        encrypted: typeof raw.encryptedText === 'string' && raw.encryptedText.length > 0,
        summaryTextAvailable: Array.isArray(raw.summaryText) ? raw.summaryText.length > 0 : typeof raw.summaryText === 'string' && raw.summaryText.length > 0,
        redacted: raw.redacted === true,
        sourceUpstreamId: raw.sourceUpstreamId || null,
        sourceModelId: raw.sourceModelId || null,
        raw
      }
    ];
  }

  if (role === 'tool-invocation') {
    const name = raw.toolName || raw.name || null;
    const callId = raw.toolCallId || raw.id || null;
    if (state === 'call') return [{ type: 'tool-call', name, callId, args: parseMaybeJson(raw.toolArguments), raw }];
    if (state === 'result') return [{ type: 'tool-result', name, callId, result: raw.result, data: raw.data, raw }];
    return [{ type: 'tool-invocation', state: state || null, name, callId, raw }];
  }

  if (role === 'source') {
    return [{ type: 'source', source: raw.source || null, callId: raw.toolCallId || null, raw }];
  }

  if (role === 'ui-component') {
    return [
      {
        type: 'ui-component',
        state: state || null,
        name: raw.name || null,
        data: raw.data || null,
        toolCallId: raw.toolCallId || null,
        toolName: raw.toolName || null,
        raw
      }
    ];
  }

  if (role === 'generated-image') {
    return [
      {
        type: 'image',
        b64: typeof raw.result === 'string' ? raw.result : null,
        format: raw.format || 'jpeg',
        width: raw.width,
        height: raw.height,
        id: raw.id || null,
        moderationToken: raw.moderationToken || null,
        raw
      }
    ];
  }

  if (role === 'partial-image') {
    return [
      {
        type: 'image-partial',
        b64: typeof raw.result === 'string' ? raw.result : null,
        format: raw.format || 'jpeg',
        width: raw.width,
        height: raw.height,
        id: raw.id || null,
        raw
      }
    ];
  }

  if (role === 'refusal') {
    return [{ type: 'refusal', detectedBy: raw.detectedBy || null, raw }];
  }

  if (role === 'image-validated') {
    return [{ type: 'image-validated', tokens: Array.isArray(raw.tokens) ? raw.tokens : [], raw }];
  }

  return [{ type: 'unknown-event', raw }];
}

/**
 * Extract the canonical source list from a `WebSearch` tool result payload.
 * Upstream shape: `data.citations: [{ id, url, title, domain, root_domain, site_name, published, chunkIds }]`
 * @param {any} data
 */
export function extractCitations(data) {
  if (!data || typeof data !== 'object') return [];
  const list = Array.isArray(data.citations)
    ? data.citations
    : Array.isArray(data.urls)
      ? data.urls.map((url, index) => ({ id: index + 1, url }))
      : [];
  return normalizeSources(list);
}

/**
 * Normalize a heterogeneous source list (citations, `role:"source"` events, `data.urls`) into
 * `{ id, url, title, snippet?, siteName?, domain?, published? }`.
 * @param {Array<any>} list
 */
export function normalizeSources(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item) continue;
    if (typeof item === 'string') {
      out.push({ id: out.length + 1, url: item, title: item });
      continue;
    }
    const url = item.url || item.link || '';
    if (!url) continue;
    out.push({
      id: item.id ?? out.length + 1,
      url,
      title: item.title || item.site || item.site_name || url,
      ...(item.snippet ? { snippet: item.snippet } : item.description ? { snippet: item.description } : {}),
      ...(item.site_name || item.site ? { siteName: item.site_name || item.site } : {}),
      ...(item.domain ? { domain: item.domain } : {}),
      ...(item.root_domain ? { rootDomain: item.root_domain } : {}),
      ...(item.published !== undefined ? { published: item.published } : {}),
      ...(Array.isArray(item.chunkIds) ? { chunkIds: item.chunkIds } : {})
    });
  }
  return out;
}

/**
 * Collect the `src` ids referenced by inline citation markers.
 * @param {string} text
 * @returns {string[]}
 */
export function collectCitationIds(text) {
  const ids = [];
  if (!text) return ids;
  const regex = new RegExp(CITATION_MARKER_RE.source, 'gi');
  let match;
  while ((match = regex.exec(text)) !== null) {
    for (const part of String(match[1] || '').split(',')) {
      const id = part.trim();
      if (id) ids.push(id);
    }
  }
  return ids;
}

/**
 * Remove inline citation markers from assistant text (for OpenAI-style clean output).
 * @param {string} text
 * @returns {string}
 */
export function stripCitationMarkers(text) {
  return String(text || '').replace(new RegExp(CITATION_MARKER_RE.source, 'gi'), '');
}

/**
 * Replace inline citation markers with markdown links, using the collected source list.
 * Unknown ids degrade to a bare `[N]` marker.
 * @param {string} text
 * @param {Array<{ id: any, url: string, title?: string }>} sources
 * @returns {string}
 */
export function citationsToMarkdown(text, sources = []) {
  const byId = new Map();
  for (const source of sources) byId.set(String(source.id), source);
  return String(text || '').replace(new RegExp(CITATION_MARKER_RE.source, 'gi'), (_full, ids) => {
    const parts = String(ids || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (!parts.length) return '';
    return parts
      .map((id) => {
        const source = byId.get(id);
        if (!source) return `[${id}]`;
        return `[${id}](${source.url})`;
      })
      .join('');
  });
}

/**
 * Streaming consumer used by the client: pulls SSE records, normalizes payloads and invokes
 * `onEvent(event, index)` for each one.
 *
 * Strict mode throws `SSEProtocolError` on the first deviation (invalid JSON, unknown role,
 * `action:"error"` frame, unknown normalized type) with `eventIndex` pointing at the raw frame.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {{ onEvent?: (event: Record<string, any>, index: number) => void, signal?: AbortSignal, strict?: boolean, allowedTypes?: Set<string> }} [options]
 * @returns {Promise<{ events: Array<Record<string, any>>, sawDone: boolean, eventCount: number }>}
 */
export async function consumeSSE(body, options = {}) {
  const { onEvent, signal, strict = false, allowedTypes = KNOWN_EVENT_TYPES } = options;
  const events = [];
  let sawDone = false;
  let eventIndex = -1;

  for await (const record of readSSEStream(body)) {
    if (signal?.aborted) break;
    if (record.field !== 'data') continue;
    eventIndex += 1;
    let normalized;
    try {
      normalized = normalizeSSEPayload(record.value);
    } catch (error) {
      if (strict) {
        throw new SSEProtocolError(`failed to normalize SSE frame: ${String(error && error.message)}`, {
          code: 'upstream_protocol_mismatch',
          eventIndex,
          snippet: redactSnippet(record.value),
          cause: error
        });
      }
      normalized = [{ type: 'unknown', raw: record.value }];
    }

    for (const event of normalized) {
      if (strict) {
        if (event.type === 'unknown') {
          throw new SSEProtocolError('SSE frame is not valid JSON (and not a known pseudo marker)', {
            code: 'upstream_protocol_mismatch',
            eventIndex,
            snippet: redactSnippet(record.value)
          });
        }
        if (event.type === 'unknown-event') {
          const role = event.raw && typeof event.raw === 'object' && !Array.isArray(event.raw) ? event.raw.role : undefined;
          throw new SSEProtocolError(`unknown SSE event role "${String(role)}"`, {
            code: 'upstream_protocol_mismatch',
            eventIndex,
            snippet: redactSnippet(record.value)
          });
        }
        if (event.type === 'error') {
          throw new SSEProtocolError(event.message || 'upstream error frame', {
            code: event.code || 'upstream_error',
            status: event.status,
            retriable: event.retriable,
            eventIndex,
            snippet: redactSnippet(record.value)
          });
        }
        if (!allowedTypes.has(event.type)) {
          throw new SSEProtocolError(`unexpected SSE event type "${event.type}"`, {
            code: 'upstream_protocol_mismatch',
            eventIndex,
            snippet: redactSnippet(record.value)
          });
        }
      }
      events.push(event);
      if (event.type === 'done') sawDone = true;
      onEvent?.(event, eventIndex);
    }
  }

  return { events, sawDone, eventCount: eventIndex + 1 };
}

export default {
  readSSEStream,
  normalizeSSEPayload,
  normalizeUpstreamEvent,
  parseDoneFrame,
  consumeSSE,
  stripCitationMarkers,
  citationsToMarkdown,
  redactSnippet
};
