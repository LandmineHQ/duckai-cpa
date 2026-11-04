import { useState } from 'react';
import { Brain, ChevronDown, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 推理摘要展示：
 * - reasoning 非空 → 可折叠「推理过程」
 * - 只有加密摘要（reasoningEncrypted=true 且 reasoning 为空）→ 小字提示，不渲染空折叠块
 */
export function ReasoningBlock({
  text,
  encrypted = false,
  defaultOpen = false
}: {
  text?: string;
  encrypted?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (!text) {
    if (!encrypted) return null;
    return (
      <div className="flex items-center gap-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
        <Lock className="h-3 w-3 shrink-0" />
        推理已加密（匿名档不提供明文）
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <Brain className="h-3.5 w-3.5" />
        推理过程
        <ChevronDown className={cn('ml-auto h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap border-t px-2.5 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
          {text}
        </pre>
      ) : null}
    </div>
  );
}
