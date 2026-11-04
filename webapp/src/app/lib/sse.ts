import type { TestStreamEvent } from './types';

/**
 * 消费 fetch ReadableStream 形式的 SSE。
 * 兼容 `data: {...}` 与 `event: xxx\ndata: {...}`，忽略注释行（`: keep-alive`）。
 */
export async function consumeSSE(
  response: Response,
  onEvent: (event: TestStreamEvent) => void
): Promise<void> {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('当前环境不支持流式响应（response.body 不可读）');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let stopped = false;

  const handleLine = (rawLine: string): void => {
    if (stopped) return;
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) return;
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      stopped = true;
      return;
    }
    try {
      const event = JSON.parse(payload) as TestStreamEvent;
      if (event && typeof event === 'object') {
        onEvent(event);
        if (event.type === 'done' || event.type === 'error') stopped = true;
      }
    } catch {
      /* 忽略无法解析的行（严格校验由服务端负责） */
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || stopped) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index !== -1 && !stopped) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line);
        index = buffer.indexOf('\n');
      }
    }
    if (!stopped && buffer.trim()) {
      handleLine(buffer);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

/** 供调用方判断响应是否为 SSE。 */
export function isEventStreamResponse(response: Response): boolean {
  return (response.headers.get('content-type') || '').includes('text/event-stream');
}
