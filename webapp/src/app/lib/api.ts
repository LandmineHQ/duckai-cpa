import { readStoredToken } from './token';

const API_BASE = '/admin/api';

export class ApiError extends Error {
  status: number;
  code: string | null;
  payload: unknown;
  handled: boolean;

  constructor(
    message: string,
    options: { status?: number; code?: string | null; payload?: unknown; handled?: boolean } = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status ?? 0;
    this.code = options.code ?? null;
    this.payload = options.payload ?? null;
    this.handled = options.handled ?? false;
  }
}

type UnauthorizedHandler = (message: string) => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = readStoredToken();
  const headers: Record<string, string> = { Accept: 'application/json', ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function readErrorMessage(response: Response): Promise<{ message: string; code: string | null }> {
  try {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = (await response.json()) as {
        error?: { message?: string; code?: string | null };
        message?: string;
      };
      return {
        message: data?.error?.message || data?.message || `请求失败（HTTP ${response.status}）`,
        code: data?.error?.code ?? null
      };
    }
    const text = (await response.text()).trim();
    return { message: text ? text.slice(0, 240) : `请求失败（HTTP ${response.status}）`, code: null };
  } catch {
    return { message: `请求失败（HTTP ${response.status}）`, code: null };
  }
}

/** 从已解析的 JSON body 提取错误文案（避免 body 被消费后 readErrorMessage 读不到）。 */
function extractErrorDetail(data: unknown): { message: string; code: string | null } | null {
  if (!data || typeof data !== 'object') return null;
  const payload = data as {
    error?: { message?: string; code?: string | null };
    message?: string;
  };
  const message = payload.error?.message || payload.message;
  if (!message) return null;
  return { message, code: payload.error?.code ?? null };
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** 登录校验时不要触发全局 401 处理。 */
  suppressAuthHandler?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, suppressAuthHandler = false } = options;
  const headers = authHeaders(body === undefined ? {} : { 'Content-Type': 'application/json' });

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: 'same-origin',
      cache: 'no-store'
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new ApiError('无法连接管理服务，请确认网关进程仍在运行。', { code: 'network_error' });
  }

  if (response.status === 401) {
    const detail = await readErrorMessage(response);
    if (!suppressAuthHandler) unauthorizedHandler?.(detail.message || '管理 token 无效或已过期，请重新登录。');
    throw new ApiError(detail.message || '管理 token 无效或已过期，请重新登录。', {
      status: 401,
      code: 'unauthorized',
      payload: detail,
      handled: !suppressAuthHandler
    });
  }

  const contentType = response.headers.get('content-type') || '';
  let data: unknown = null;
  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    // body 已在上面按 JSON 解析过一次；优先复用它，否则再读（避免重复读取导致通用错误）
    const detail = extractErrorDetail(data) ?? (await readErrorMessage(response));
    throw new ApiError(detail.message, { status: response.status, code: detail.code, payload: data });
  }
  if (data === null) throw new ApiError('服务返回了非 JSON 响应', { status: response.status });
  return data as T;
}

export function apiGet<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
  return apiRequest<T>(path, { ...options, method: 'GET' });
}

export function apiPost<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
  return apiRequest<T>(path, { ...options, method: 'POST', body });
}

export function apiPut<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
  return apiRequest<T>(path, { ...options, method: 'PUT', body });
}

export function apiPatch<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
  return apiRequest<T>(path, { ...options, method: 'PATCH', body });
}

export function apiDelete<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
  return apiRequest<T>(path, { ...options, method: 'DELETE' });
}

/** 打开 SSE 请求（用于会话式测试），非 2xx 时抛出 ApiError。 */
export async function openEventStream(  path: string,
  body: unknown,
  options: { signal?: AbortSignal } = {}
): Promise<Response> {
  const headers = authHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' });
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: options.signal,
      credentials: 'same-origin',
      cache: 'no-store'
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new ApiError('无法连接管理服务，请确认网关进程仍在运行。', { code: 'network_error' });
  }

  if (response.status === 401) {
    const detail = await readErrorMessage(response);
    unauthorizedHandler?.(detail.message || '管理 token 无效或已过期，请重新登录。');
    throw new ApiError(detail.message, { status: 401, code: 'unauthorized', handled: true });
  }
  if (!response.ok) {
    const detail = await readErrorMessage(response);
    throw new ApiError(detail.message, { status: response.status, code: detail.code });
  }
  return response;
}

/** 由浏览器触发下载（身份导出等需要 Content-Disposition/二进制响应的场景）。 */
export async function downloadFile(path: string, fallbackName: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: authHeaders(),
      credentials: 'same-origin',
      cache: 'no-store'
    });
  } catch {
    throw new ApiError('无法连接管理服务，请确认网关进程仍在运行。', { code: 'network_error' });
  }

  if (response.status === 401) {
    const detail = await readErrorMessage(response);
    unauthorizedHandler?.(detail.message || '管理 token 无效或已过期，请重新登录。');
    throw new ApiError(detail.message, { status: 401, code: 'unauthorized', handled: true });
  }
  if (!response.ok) {
    const detail = await readErrorMessage(response);
    throw new ApiError(detail.message, { status: response.status, code: detail.code });
  }

  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = (match?.[1] || fallbackName).trim();
  const objectUrl =
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : '';
  if (!objectUrl) throw new ApiError('当前环境不支持文件下载');
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      /* ignore */
    }
  }, 1000);
  return filename;
}

/** 前端生成并下载文本文件（恢复码离线保存等）。 */
export function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const objectUrl = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : '';
  if (!objectUrl) throw new ApiError('当前环境不支持文件下载');
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      /* ignore */
    }
  }, 1000);
}
