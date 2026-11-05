import { AlertTriangle, Bot, ExternalLink, FileText, Loader2, RefreshCw, User, Wrench } from 'lucide-react';
import type { SessionMessage, ToolCallInfo } from '@/app/lib/types';
import { dataUrlForImage, formatDateTime, formatDuration, formatQueueWait } from '@/app/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ReasoningBlock } from './reasoning-block';

function safeHttpUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    /* ignore */
  }
  return null;
}

/** v2.37：工具调用 → 中文标签（位置调用 / 图片生成 / 联网搜索）。 */
const TOOL_LABELS: Record<string, string> = {
  LocationPrompt: '位置调用',
  user_location: '位置调用',
  'user-location': '位置调用',
  GenerateImage: '图片生成',
  image_generation: '图片生成',
  'generate-image': '图片生成',
  WebSearch: '联网搜索',
  web_search: '联网搜索',
  ReadDocument: '文档读取',
  read_document: '文档读取',
  FindInDocument: '文档检索',
  ReadDocumentSelection: '文档片段读取'
};

/** v2.49：PDF/文件附件 chip（会话历史只存元数据）。 */
function FileAttachmentList({ files, onPrimary = false }: { files?: Array<{ filename: string; mimeType: string; pages?: number; bytes?: number }>; onPrimary?: boolean }) {
  if (!files || files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="message-files">
      {files.map((file, index) => {
        const kb = Number.isFinite(Number(file.bytes)) ? Math.max(1, Math.round(Number(file.bytes) / 1024)) : null;
        return (
          <span
            key={`${file.filename}-${index}`}
            className={`inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${onPrimary ? 'border-primary-foreground/20 bg-primary-foreground/15 text-primary-foreground' : 'bg-muted/40 text-muted-foreground'}`}
            title={`${file.filename} · ${file.mimeType}${file.pages ? ` · ${file.pages} 页` : ''}`}
          >
            <FileText className="h-3 w-3 shrink-0" />
            <span className="truncate">{file.filename}</span>
            {file.pages ? <span className="shrink-0">· {file.pages} 页</span> : null}
            {kb ? <span className="shrink-0">· {kb} KB</span> : null}
          </span>
        );
      })}
    </div>
  );
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] || name || '工具调用';
}

/** 工具调用列表（连接测试 + 会话历史共用渲染）。 */
export function ToolCallList({ toolCalls }: { toolCalls?: ToolCallInfo[] }) {
  if (!toolCalls || toolCalls.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="message-tools">
      {toolCalls.map((call, index) => (
        <details key={`${call.name}-${index}`} className="rounded-md border bg-muted/20">
          <summary className="flex cursor-pointer list-none items-center gap-1 px-2 py-0.5 text-[10px] font-medium">
            <Wrench className="h-3 w-3 text-muted-foreground" />
            {toolLabel(call.name)}
            {call.result ? <span className="text-muted-foreground">· {String(call.result).slice(0, 24)}</span> : null}
          </summary>
          {call.args || call.result ? (
            <div className="space-y-1 border-t px-2 py-1 text-[10px] text-muted-foreground">
              {call.args ? (
                <p className="max-h-32 overflow-auto whitespace-pre-wrap break-words">参数：{call.args}</p>
              ) : null}
              {call.result ? (
                <p className="max-h-32 overflow-auto whitespace-pre-wrap break-words">结果：{call.result}</p>
              ) : null}
            </div>
          ) : null}
        </details>
      ))}
    </div>
  );
}

function MessageMeta({ message }: { message: SessionMessage }) {
  const parts: string[] = [];
  if (message.model) parts.push(message.model);
  if (typeof message.latencyMs === 'number') parts.push(`耗时 ${formatDuration(message.latencyMs)}`);
  if (typeof message.queueWaitMs === 'number' && message.queueWaitMs > 0) {
    parts.push(`排队 ${formatQueueWait(message.queueWaitMs)}`);
  }
  if (message.ts) parts.push(formatDateTime(message.ts));
  if (parts.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">{parts.join(' · ')}</div>;
}

export function ChatMessageBubble({
  message,
  streaming = false,
  retrying = false,
  retryDisabled = false,
  onRetry
}: {
  message: SessionMessage;
  streaming?: boolean;
  /** 该消息正在被重新生成（一般会被截断替换，保留以支持原位 loading）。 */
  retrying?: boolean;
  /** 有其它请求进行中时禁用重试。 */
  retryDisabled?: boolean;
  onRetry?: (message: SessionMessage) => void;
}) {
  if (message.role === 'system') {
    return (
      <div className="flex justify-center" data-testid="compaction-notice">
        <div className="max-w-[92%] rounded-full border border-primary/25 bg-primary/5 px-3 py-1.5 text-center text-[11px] leading-relaxed text-primary">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="flex justify-end gap-2">
        <div className="flex max-w-[85%] flex-col items-end gap-1">
          <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-primary px-3.5 py-2.5 text-sm text-primary-foreground">
            {message.content}
            {message.files && message.files.length ? (
              <div className="mt-1.5">
                <FileAttachmentList files={message.files} onPrimary />
              </div>
            ) : null}
          </div>
          <span className="pr-1 text-[11px] text-muted-foreground">{formatDateTime(message.ts)}</span>
        </div>
        <div className="mt-0.5 hidden h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary sm:flex">
          <User className="h-4 w-4" />
        </div>
      </div>
    );
  }

  const sources = message.sources ?? [];
  const images = message.images ?? [];
  const waiting = streaming && !message.content && !message.error;
  const retryBusy = retrying || streaming || retryDisabled;
  const canRetry = Boolean(onRetry) && !retryBusy;

  return (
    <div className="flex gap-2">
      <div className="mt-0.5 hidden h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary sm:flex">
        <Bot className="h-4 w-4" />
      </div>
      <div className="min-w-0 max-w-[95%] flex-1 space-y-2 rounded-2xl rounded-tl-sm border bg-card px-3.5 py-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">助手</span>
          {message.model ? (
            <Badge variant="outline" className="font-mono text-[10px]">
              {message.model}
            </Badge>
          ) : null}
          {message.finishReason && message.finishReason !== 'stop' ? (
            <Badge variant="warning" className="text-[10px]">
              {message.finishReason}
            </Badge>
          ) : null}
          {message.retriedFrom ? (
            <Badge variant="muted" className="text-[10px]">
              已重新生成
            </Badge>
          ) : null}
          {retrying ? (
            <Badge variant="info" className="gap-1 text-[10px]">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              重新生成中
            </Badge>
          ) : null}
          {streaming && !retrying ? (
            <Badge variant="info" className="gap-1 text-[10px]">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              生成中
            </Badge>
          ) : null}
        </div>

        <ReasoningBlock text={message.reasoning} encrypted={message.reasoningEncrypted} />

        <ToolCallList toolCalls={message.toolCalls} />

        {waiting ? (
          <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {retrying ? '正在重新生成…' : '正在等待上游响应…'}
          </div>
        ) : null}

        {message.content ? (
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {message.content}
            {streaming ? <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-primary align-middle" /> : null}
          </div>
        ) : null}

        {message.error ? (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{message.error}</span>
            {onRetry ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 shrink-0 gap-1 border-destructive/30 bg-transparent px-2 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={!canRetry}
                onClick={() => onRetry(message)}
              >
                {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                重试
              </Button>
            ) : null}
          </div>
        ) : null}

        {sources.length > 0 ? (
          <div className="space-y-1">
            <div className="text-[11px] font-medium text-muted-foreground">搜索来源</div>
            <ol className="space-y-1">
              {sources.map((source, index) => {
                const href = safeHttpUrl(source.url);
                return (
                  <li key={`${source.url}-${index}`} className="text-xs">
                    <span className="mr-1 text-muted-foreground">[{index + 1}]</span>
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                      >
                        {source.title || href}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="font-medium">{source.title || source.url}</span>
                    )}
                    {source.snippet ? (
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{source.snippet}</div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>
        ) : null}

        {images.length > 0 ? (
          <div className="space-y-1">
            <div className="text-[11px] font-medium text-muted-foreground">生成图片</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {images.map((image, index) => (
                <figure key={`${image.format ?? 'png'}-${index}`} className="overflow-hidden rounded-lg border bg-muted/30">
                  <img
                    src={dataUrlForImage(image)}
                    alt={`生成图片 ${index + 1}`}
                    className="max-h-64 w-full object-contain"
                    loading="lazy"
                  />
                  <figcaption className="px-2 py-1 text-[10px] text-muted-foreground">
                    {(image.format ?? 'png').toUpperCase()}
                    {image.width && image.height ? ` · ${image.width}×${image.height}` : ''}
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-2 pt-0.5">
          <div className="min-w-0 flex-1">
            <MessageMeta message={message} />
          </div>
          {onRetry ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  disabled={!canRetry}
                  onClick={() => onRetry(message)}
                  aria-label="重新生成这条回复"
                >
                  {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  {retrying ? '重新生成中…' : '重新生成'}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                重新生成这一轮回复（保留该轮的用户消息，丢弃其后的消息）
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </div>
  );
}
