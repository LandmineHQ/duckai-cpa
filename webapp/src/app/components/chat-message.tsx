import { useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  RefreshCw,
  Wrench
} from 'lucide-react';
import type { SessionMessage, ToolCallInfo } from '@/app/lib/types';
import { dataUrlForImage, formatDateTime, formatDuration, formatQueueWait } from '@/app/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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

function FileAttachmentList({
  files,
  onPrimary = false
}: {
  files?: Array<{ filename: string; mimeType: string; pages?: number; bytes?: number; text?: string }>;
  onPrimary?: boolean;
}) {
  const [selected, setSelected] = useState<{
    filename: string;
    mimeType: string;
    pages?: number;
    bytes?: number;
    text?: string;
  } | null>(null);
  if (!files || files.length === 0) return null;
  return (
    <>
      <div className="flex flex-wrap gap-1.5" data-testid="message-files">
        {files.map((file, index) => {
          const kb = Number.isFinite(Number(file.bytes)) ? Math.max(1, Math.round(Number(file.bytes) / 1024)) : null;
          return (
            <button
              key={`${file.filename}-${index}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setSelected(file);
              }}
              className={`inline-flex max-w-full items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition-colors ${
                onPrimary
                  ? 'border-primary-foreground/20 bg-primary-foreground/15 text-primary-foreground hover:bg-primary-foreground/25'
                  : 'border-border/80 bg-background/80 text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
              title={`${file.filename} · ${file.mimeType}${file.pages ? ` · ${file.pages} 页` : ''}（点击查看 PDF 文本）`}
              data-testid="message-file-chip"
            >
              <FileText className="h-3 w-3 shrink-0 text-primary" />
              <span className="truncate font-medium">{file.filename}</span>
              {file.pages ? <span className="shrink-0">· {file.pages} 页</span> : null}
              {kb ? <span className="shrink-0">· {kb} KB</span> : null}
            </button>
          );
        })}
      </div>
      <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              {selected?.filename || 'PDF'}
            </DialogTitle>
            <DialogDescription>
              {selected?.mimeType || 'application/pdf'}
              {selected?.pages ? ` · ${selected.pages} 页` : ''}
              {selected?.bytes ? ` · ${Math.max(1, Math.round(selected.bytes / 1024))} KB` : ''}
            </DialogDescription>
          </DialogHeader>
          {selected?.text ? (
            <pre
              className="scrollbar-thin max-h-[62vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed"
              data-testid="message-file-text"
            >
              {selected.text}
            </pre>
          ) : (
            <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
              该历史记录没有保存 PDF 文本内容（v2.50 之前的记录）；新记录会显示完整文本。
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

const COMPACTION_MARKER = 'Another language model started to solve this problem';

function toolLabel(name: string): string {
  return TOOL_LABELS[name] || name || '工具调用';
}

export function ToolCallList({ toolCalls }: { toolCalls?: ToolCallInfo[] }) {
  if (!toolCalls || toolCalls.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="message-tools">
      {toolCalls.map((call, index) => (
        <details key={`${call.name}-${index}`} className="rounded-lg border border-border/70 bg-muted/25">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium">
            <Wrench className="h-3 w-3 text-primary/80" />
            <span>{toolLabel(call.name)}</span>
            {call.result ? <span className="text-muted-foreground">· {String(call.result).slice(0, 24)}</span> : null}
          </summary>
          {call.args || call.result ? (
            <div className="space-y-1 border-t px-2.5 py-1.5 text-[11px] text-muted-foreground">
              {call.args ? (
                <p className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px]">参数：{call.args}</p>
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
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">{parts.join(' · ')}</div>;
}

function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
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
  retrying?: boolean;
  retryDisabled?: boolean;
  onRetry?: (message: SessionMessage) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  if (message.role === 'system') {
    return (
      <div className="flex justify-center py-1" data-testid="compaction-notice">
        <div className="max-w-[92%] rounded-full border border-primary/25 bg-primary/5 px-3.5 py-1 text-center text-[11px] leading-relaxed text-primary">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === 'user' && String(message.content || '').startsWith(COMPACTION_MARKER)) {
    const summary = String(message.content || '');
    return (
      <div className="rounded-xl border border-primary/25 bg-primary/5 p-3.5" data-testid="compaction-notice">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="success" className="px-1.5 py-0 text-[10px]">上下文已压缩</Badge>
          <span className="text-[11px] text-muted-foreground">以下是上一次会话的摘要，旧消息已写入 PDF</span>
        </div>
        {message.files && message.files.length ? <div className="mt-2"><FileAttachmentList files={message.files} /></div> : null}
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">查看压缩摘要（{summary.length} 字符）</summary>
          <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background p-2.5 text-[11px]">{summary}</pre>
        </details>
      </div>
    );
  }

  if (message.role === 'user') {
    const userImages = message.images ?? [];
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[82%] flex-col items-end gap-1.5">
          {userImages.length > 0 ? (
            <div className="flex flex-wrap justify-end gap-2">
              {userImages.map((image, idx) => {
                const src = dataUrlForImage(image);
                return (
                  <img
                    key={`user-img-${idx}`}
                    src={src}
                    alt={`上传图片 ${idx + 1}`}
                    className="h-28 w-28 cursor-zoom-in rounded-2xl border border-border/80 object-cover shadow-xs"
                    onClick={() => setPreviewSrc(src)}
                  />
                );
              })}
            </div>
          ) : null}
          <div className="rounded-3xl bg-muted/85 px-4 py-2.5 text-[14.5px] leading-relaxed text-foreground shadow-2xs ring-1 ring-border/50">
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
            {message.files && message.files.length ? (
              <div className="mt-2">
                <FileAttachmentList files={message.files} />
              </div>
            ) : null}
          </div>
          {message.ts ? (
            <span className="pr-1 text-[10.5px] text-muted-foreground/75">{formatDateTime(message.ts)}</span>
          ) : null}
        </div>
        <Dialog open={Boolean(previewSrc)} onOpenChange={(open) => { if (!open) setPreviewSrc(null); }}>
          <DialogContent className="max-w-3xl p-2">
            {previewSrc ? <img src={previewSrc} alt="大图预览" className="max-h-[80vh] w-full rounded-lg object-contain" /> : null}
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  const sources = message.sources ?? [];
  const images = message.images ?? [];
  const waiting = streaming && !message.content && !message.error;
  const retryBusy = retrying || streaming || retryDisabled;
  const canRetry = Boolean(onRetry) && !retryBusy;

  const copyContent = () => {
    if (!message.content) return;
    navigator.clipboard?.writeText(message.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };

  return (
    <div className="group flex items-start gap-3.5 py-1">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-primary/25 bg-primary/10 text-primary shadow-2xs">
        <Bot className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {message.model ? (
            <span className="font-mono text-[11px] font-medium text-muted-foreground">
              {message.model}
            </span>
          ) : (
            <span className="text-xs font-medium text-muted-foreground">助手</span>
          )}
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
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <span>{retrying ? '正在重新生成…' : '正在思考并等待上游响应…'}</span>
          </div>
        ) : null}

        {message.content ? (
          <div className="whitespace-pre-wrap break-words text-[14.5px] leading-7 text-foreground/95">
            {message.content}
            {streaming ? <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-xs bg-primary align-middle" /> : null}
          </div>
        ) : null}

        {message.error ? (
          <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
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

        {images.length > 0 ? (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {images.map((image, index) => {
              const src = dataUrlForImage(image);
              const fmt = (image.format ?? 'png').toLowerCase();
              return (
                <figure key={`${fmt}-${index}`} className="group/img relative overflow-hidden rounded-2xl border bg-muted/30">
                  <img
                    src={src}
                    alt={`生成图片 ${index + 1}`}
                    className="max-h-80 w-full cursor-zoom-in object-contain"
                    loading="lazy"
                    onClick={() => setPreviewSrc(src)}
                  />
                  <div className="flex items-center justify-between border-t bg-card/80 px-2.5 py-1 text-[10.5px] text-muted-foreground">
                    <span>
                      {fmt.toUpperCase()}
                      {image.width && image.height ? ` · ${image.width}×${image.height}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => downloadDataUrl(src, `duckai-image-${index + 1}.${fmt === 'jpeg' ? 'jpg' : fmt}`)}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
                    >
                      <Download className="h-3 w-3" />
                      下载
                    </button>
                  </div>
                </figure>
              );
            })}
          </div>
        ) : null}

        {sources.length > 0 ? (
          <div className="rounded-xl border border-border/70 bg-muted/25 p-2.5">
            <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">搜索来源（{sources.length}）</div>
            <ol className="space-y-1.5">
              {sources.map((source, index) => {
                const href = safeHttpUrl(source.url);
                return (
                  <li key={`${source.url}-${index}`} className="text-xs">
                    <span className="mr-1.5 font-mono text-[10.5px] text-muted-foreground">[{index + 1}]</span>
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

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {message.content ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={copyContent}
            >
              {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
              {copied ? '已复制' : '复制'}
            </Button>
          ) : null}
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
          <div className="ml-auto">
            <MessageMeta message={message} />
          </div>
        </div>
      </div>

      <Dialog open={Boolean(previewSrc)} onOpenChange={(open) => { if (!open) setPreviewSrc(null); }}>
        <DialogContent className="max-w-4xl p-2">
          {previewSrc ? <img src={previewSrc} alt="图片大图预览" className="max-h-[82vh] w-full rounded-lg object-contain" /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
