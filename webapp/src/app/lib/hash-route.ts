import { useCallback, useEffect, useState } from 'react';

export const ROUTES = [
  'overview',
  'chat',
  'identity',
  'identities',
  'subscriptions',
  'history',
  'proxy',
  'settings',
  'model-config',
  'keys',
  'logs',
  'examples'
] as const;
export type Route = (typeof ROUTES)[number];

export const ROUTE_META: Record<Route, { title: string; description: string }> = {
  overview: { title: '概览', description: '上游健康、RPS 队列与请求统计' },
  chat: { title: '连接测试', description: '会话式连续对话，真实调用 duck.ai' },
  identity: { title: '默认身份', description: '默认匿名身份（journeyId/指纹）与 DuckDuckGo Sync & Backup' },
  identities: { title: '身份池', description: '匿名分身池、会话绑定、订阅绑定与路由策略' },
  subscriptions: { title: '订阅', description: 'DuckDuckGo Plus/Pro 订阅池：一个订阅可绑定多个身份' },
  history: { title: '会话历史', description: '按身份分组的只读会话记录（SQLite，默认保留 30 天）' },
  proxy: { title: '代理', description: '网关出站代理（HTTP/HTTPS/SOCKS），含连通性测试' },
  settings: { title: '设置', description: '队列、模型、提示词与日志配置' },
  'model-config': {
    title: '模型配置',
    description: '按模型自定义上下文窗口 / 单条输入 / 输出上限（默认 duck.ai 实测值）'
  },
  keys: { title: 'API Key', description: '强制鉴权：所有 /v1/* 请求都需要 API Key' },
  logs: { title: '日志', description: '上游请求与后台 API 日志（分开存储）' },
  examples: { title: '调用示例', description: 'cURL / OpenAI SDK / Responses 示例' }
};

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '').split(/[?&#]/)[0];
  return (ROUTES as readonly string[]).includes(raw) ? (raw as Route) : 'overview';
}

export function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash());

  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  useEffect(() => {
    // 只在「hash 为空」时补默认路由；**不要**重写带查询串的 hash，
    // 否则会丢掉订阅登录回调的 `?sessionId=..&token=..`（v2.26）。
    if (!window.location.hash) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}#/${parseHash()}`
      );
    }
    // 只在首次挂载时归一化 hash
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = useCallback((next: Route) => {
    if (parseHash() === next) {
      setRoute(next);
      return;
    }
    window.location.hash = `#/${next}`;
  }, []);

  return [route, navigate];
}
