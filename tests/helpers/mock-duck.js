/**
 * Mock DuckClient used by the OpenAI-layer / Admin-API integration tests.
 *
 * Implements the ARCHITECTURE.md §4 contract exactly:
 *   init(), getModelCatalog(), chat(params, handlers), imageGeneration(params), health()
 *
 * Behaviour is scripted per test:
 *   mock.chatBehavior = { textDeltas, reasoningDeltas, sources, images, usage, error, ... }
 *   mock.enqueueChat({...})  → one-shot behaviour consumed by the next chat() call
 *   mock.imageBehavior = { images: [...] } | { error }
 *   mock.healthBehavior = { ok, version, challengeOk } | { error }
 *
 * Every call is recorded in `mock.calls` so tests can assert what the OpenAI layer
 * actually forwarded upstream (model / messages / reasoningEffort / tool flags).
 */

import { DUCK_MODELS } from '../../src/duck/models.js';

/** 1x1 transparent PNG — valid base64 that decodes to real PNG magic bytes. */
export const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 1x1 JPEG (from a real duck.ai image-partial capture style). */
export const JPEG_PARTIAL_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

export const DEFAULT_SOURCES = [
  {
    id: 0,
    url: 'https://www.accuweather.com/en/us/new-york-city/10007/weather-forecast/349727',
    title: 'New York City, NY Weather Forecast | AccuWeather',
    snippet: 'Mostly cloudy with a high of 12°C.',
    siteName: 'AccuWeather',
    domain: 'accuweather.com'
  },
  {
    id: 1,
    url: 'https://weather.com/weather/today/l/10001:4:US',
    title: 'New York City Weather Today - The Weather Channel',
    snippet: 'Partly cloudy, 12°C.',
    siteName: 'The Weather Channel',
    domain: 'weather.com'
  }
];

export function defaultChatBehavior(overrides = {}) {
  return {
    textDeltas: ['你好', '，', '世界', '！'],
    reasoningDeltas: [],
    reasoningEncrypted: false,
    sources: [],
    images: [],
    usage: null,
    finishReason: 'stop',
    delayMs: 0,
    perEventDelayMs: 0,
    error: null,
    ...overrides
  };
}

export class MockDuckClient {
  constructor(options = {}) {
    this.calls = {
      init: 0,
      chat: [],
      imageGeneration: [],
      health: 0,
      summarize: []
    };
    /** RPS 队列测试用：并发/开始时间观测。 */
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.chatStarts = [];
    this.imageStarts = [];
    this._active = 0;
    this.catalog =
      options.catalog ??
      DUCK_MODELS.map((model) => ({ ...model, id: model.model }));
    this.chatBehavior = defaultChatBehavior(options.chat);
    // v2.11：compact 摘要（ctx.callUpstream → client.summarizeMessages）
    this.summarizeBehavior = {
      text: '- 摘要：用户目标与已确认事实（mock）',
      model: 'gpt-6-luna',
      coveredMessageCount: null,
      finishReason: 'stop',
      ...(options.summarize || {})
    };
    this._summarizeQueue = [];
    this._queue = [];
    this.imageBehavior = {
      images: [
        { b64: PNG_1X1_B64, format: 'png', width: 1024, height: 1024, modelDisplayName: 'GPT Image 2' }
      ],
      modelDisplayName: 'GPT Image 2',
      ...(options.image || {})
    };
    this.healthBehavior = {
      ok: true,
      upstreamStatus: '0',
      challengeOk: true,
      version: 'serp_20261030_223718_ET-61e4601227ece8af7a1ad4d69b79aafd35f91fae',
      ...(options.health || {})
    };
    this.initResult = options.init ?? { ok: true, version: this.healthBehavior.version };
  }

  /** Reset concurrency observations (not behaviours). */
  resetObservations() {
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.chatStarts = [];
    this.imageStarts = [];
    this._active = 0;
  }

  _enter(startedAt) {
    this._active += 1;
    this.inFlight = this._active;
    if (this.inFlight > this.maxInFlight) this.maxInFlight = this.inFlight;
    return startedAt;
  }

  _exit() {
    this._active = Math.max(0, this._active - 1);
    this.inFlight = this._active;
  }


  async init() {
    this.calls.init += 1;
    return this.initResult;
  }

  getModelCatalog() {
    return this.catalog;
  }

  async health() {
    this.calls.health += 1;
    if (this.healthBehavior.error) throw this.healthBehavior.error;
    return this.healthBehavior;
  }

  /** Queue a one-shot chat behaviour. */
  enqueueChat(behavior) {
    this._queue.push(behavior);
    return this;
  }

  /** Resolve the behaviour for one chat call (one-shot queue first, then default). */
  _takeChatBehavior() {
    const queued = this._queue.shift();
    return queued ? defaultChatBehavior(queued) : this.chatBehavior;
  }

  /** Queue a one-shot summarize behaviour. */
  enqueueSummarize(behavior) {
    this._summarizeQueue.push(behavior);
    return this;
  }

  async summarizeMessages(request = {}) {
    this.calls.summarize.push({ request, at: Date.now() });
    const queued = this._summarizeQueue.shift();
    const behavior = queued ? { ...this.summarizeBehavior, ...queued } : this.summarizeBehavior;
    if (behavior.error) throw behavior.error;
    return {
      ok: true,
      text: behavior.text,
      summary: behavior.text,
      model: behavior.model || 'gpt-6-luna',
      coveredMessageCount: Number.isFinite(behavior.coveredMessageCount)
        ? behavior.coveredMessageCount
        : Array.isArray(request.messages)
          ? request.messages.length
          : 0,
      finishReason: behavior.finishReason || 'stop'
    };
  }

  async chat(params = {}, handlers = {}) {
    const startedAt = Date.now();
    this.chatStarts.push(startedAt);
    this._enter(startedAt);
    try {
      const record = {
        params,
        messages: Array.isArray(params.messages) ? params.messages.map((m) => ({ ...m })) : [],
        startedAt
      };
      this.calls.chat.push(record);

      const behavior = this._takeChatBehavior();
      const emit = async (fn) => {
        if (typeof fn !== 'function') return;
        fn();
        if (behavior.perEventDelayMs > 0) await sleep(behavior.perEventDelayMs);
      };

      if (behavior.delayMs > 0) await sleep(behavior.delayMs);

      if (behavior.error) throw behavior.error;

      for (const text of behavior.textDeltas || []) {
        await emit(() => handlers.onTextDelta?.(text));
      }
      if (behavior.errorAfterText) {
        handlers.onError?.(behavior.errorAfterText);
        throw behavior.errorAfterText;
      }
      for (const text of behavior.reasoningDeltas || []) {
        await emit(() => handlers.onReasoningDelta?.(text));
      }
      if (behavior.sources && behavior.sources.length) {
        await emit(() => handlers.onSearchResults?.(behavior.sources));
      }
      for (const image of behavior.images || []) {
        await emit(() => handlers.onImage?.(image));
      }
      for (const call of behavior.toolCalls || []) {
        await emit(() => handlers.onToolCall?.(call));
      }
      for (const result of behavior.toolResults || []) {
        await emit(() => handlers.onToolResult?.(result));
      }
      if (behavior.usage) await emit(() => handlers.onUsage?.(behavior.usage));

      if (behavior.result) return behavior.result;

      return {
        content: (behavior.textDeltas || []).join(''),
        reasoning: (behavior.reasoningDeltas || []).join(''),
        reasoningEncrypted: behavior.reasoningEncrypted === true,
        sources: behavior.sources || [],
        images: behavior.images || [],
        finishReason: behavior.finishReason || 'stop',
        rawEvents: [],
        model: params.model,
        reasoningEffort: params.reasoningEffort
      };
    } finally {
      this._exit();
    }
  }

  async imageGeneration(params = {}) {
    const startedAt = Date.now();
    this.imageStarts.push(startedAt);
    this._enter(startedAt);
    try {
      this.calls.imageGeneration.push({ params, startedAt });
      if (this.imageBehavior.error) throw this.imageBehavior.error;
      return this.imageBehavior;
    } finally {
      this._exit();
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default MockDuckClient;
