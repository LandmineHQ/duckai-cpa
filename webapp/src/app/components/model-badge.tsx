import type { ReactNode } from 'react';
import { Gauge, Globe2, ImageIcon, Lock } from 'lucide-react';
import type { ModelInfo } from '@/app/lib/types';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

function formatChars(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
  return value.toLocaleString('en-US');
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** v2.11：统一真实后端 `capabilities`（对象）与旧 mock（字符串数组）两种形状。 */
function modelCapabilityInfo(model: ModelInfo) {
  const rawCapabilities = model.capabilities;
  const capabilityObject =
    rawCapabilities && !Array.isArray(rawCapabilities) && typeof rawCapabilities === 'object'
      ? (rawCapabilities as Record<string, unknown>)
      : {};
  const capabilityList = Array.isArray(rawCapabilities)
    ? rawCapabilities.filter((item): item is string => typeof item === 'string')
    : [];
  const tools = Array.isArray(model.tools) ? model.tools.filter((item): item is string => typeof item === 'string') : [];
  const hasWeb =
    capabilityObject.webSearch === true ||
    capabilityList.includes('web_search') ||
    capabilityList.includes('webSearch') ||
    tools.includes('web_search') ||
    tools.includes('webSearch');
  const hasImage =
    capabilityObject.imageGeneration === true ||
    capabilityList.includes('image_generation') ||
    capabilityList.includes('imageGeneration') ||
    tools.includes('image_generation') ||
    tools.includes('imageGeneration');
  const rawEfforts =
    (Array.isArray(model.supported_reasoning_efforts) && model.supported_reasoning_efforts) ||
    (Array.isArray(model.reasoningEfforts) && model.reasoningEfforts) ||
    (Array.isArray(capabilityObject.reasoningEfforts) && (capabilityObject.reasoningEfforts as unknown[])) ||
    [];
  const efforts = (rawEfforts as unknown[]).filter((item): item is string => typeof item === 'string');
  const contextWindowChars =
    toFiniteNumber(model.contextWindowChars) ?? toFiniteNumber(capabilityObject.contextWindowChars);
  const maxInputChars = toFiniteNumber(model.maxInputChars) ?? toFiniteNumber(capabilityObject.maxInputChars);
  const maxOutputTokens = toFiniteNumber(model.maxOutputTokens) ?? toFiniteNumber(capabilityObject.maxOutputTokens);
  const tier =
    (typeof model.tier === 'string' && model.tier) ||
    (typeof capabilityObject.tier === 'string' ? capabilityObject.tier : null);
  // v2.12：压缩支持（顶层或 capabilities 对象内）
  const compactionSupported =
    typeof model.compactionSupported === 'boolean'
      ? model.compactionSupported
      : typeof capabilityObject.compactionSupported === 'boolean'
        ? (capabilityObject.compactionSupported as boolean)
        : null;
  const activationTargetPairCount =
    toFiniteNumber(model.activationTargetPairCount) ?? toFiniteNumber(capabilityObject.activationTargetPairCount);
  const inputCharLimit =
    toFiniteNumber(model.inputCharLimit) ??
    toFiniteNumber(capabilityObject.inputCharLimit) ??
    toFiniteNumber(capabilityObject.maxInputChars);
  return {
    tools,
    hasWeb,
    hasImage,
    efforts,
    contextWindowChars,
    maxInputChars,
    maxOutputTokens,
    tier,
    compactionSupported,
    activationTargetPairCount,
    inputCharLimit
  };
}

/** v2.12：模型压缩支持标识（不支持自动压缩时明确提示，避免误解）。 */
export function ModelCompactionBadge({ model }: { model: ModelInfo }) {
  const info = modelCapabilityInfo(model);
  if (info.compactionSupported === false) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="warning" className="text-[10px]" data-testid="model-compaction-unsupported">
            不支持自动压缩
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          该模型不会自动压缩上下文；接近限制时请手动点「压缩会话」或新建会话。
        </TooltipContent>
      </Tooltip>
    );
  }
  if (info.compactionSupported === true) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="text-[10px]" data-testid="model-compaction-supported">
            支持自动压缩{info.activationTargetPairCount ? ` · 约 ${info.activationTargetPairCount} 轮后` : ''}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          {info.activationTargetPairCount
            ? `约 ${info.activationTargetPairCount} 轮对话后自动压缩；也可手动点「压缩会话」。`
            : '该模型支持自动压缩上下文。'}
        </TooltipContent>
      </Tooltip>
    );
  }
  return null;
}

/** v2.11：模型能力标签（免费/付费、联网、图片、推理档位）。 */
export function ModelCapabilityBadges({ model }: { model: ModelInfo }) {
  const info = modelCapabilityInfo(model);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge variant={model.paid ? 'warning' : 'success'} className="text-[10px]">
        {model.paid ? info.tier || '付费' : '免费'}
      </Badge>
      {info.hasWeb ? (
        <Badge variant="outline" className="gap-1 text-[10px]">
          <Globe2 className="h-2.5 w-2.5" />
          联网
        </Badge>
      ) : null}
      {info.hasImage ? (
        <Badge variant="outline" className="gap-1 text-[10px]">
          <ImageIcon className="h-2.5 w-2.5" />
          图片
        </Badge>
      ) : null}
      {model.reasoning ? (
        <Badge variant="outline" className="text-[10px]">
          推理{info.efforts.length > 0 ? ` ${info.efforts.length} 档` : ''}
        </Badge>
      ) : null}
    </div>
  );
}

/** v2.11：上下文能力（字符）+ tokens 估算提示。 */
export function ModelContextLine({ model }: { model: ModelInfo }) {
  const { contextWindowChars, maxInputChars, maxOutputTokens } = modelCapabilityInfo(model);
  if (!contextWindowChars && !maxInputChars && !maxOutputTokens) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
      {contextWindowChars ? (
        <span className="inline-flex items-center gap-1">
          <Gauge className="h-2.5 w-2.5" />
          上下文约 {formatChars(contextWindowChars)} 字符（估算 tokens）
        </span>
      ) : null}
      {maxInputChars ? <span>输入上限 {formatChars(maxInputChars)} 字符</span> : null}
      {maxOutputTokens ? <span>输出 {formatChars(maxOutputTokens)} tokens</span> : null}
    </div>
  );
}

export function isModelLocked(model: ModelInfo | null | undefined, allowPaidModels: boolean): boolean {
  if (!model) return false;
  if (!model.paid) return false;
  return !allowPaidModels || model.available === false;
}

export function ModelTierBadge({ model, allowPaidModels }: { model: ModelInfo; allowPaidModels: boolean }) {
  if (!model.paid) return <Badge variant="success">免费</Badge>;
  const locked = isModelLocked(model, allowPaidModels);
  return (
    <Badge variant={locked ? 'muted' : 'warning'} className="gap-1">
      {locked ? <Lock className="h-3 w-3" /> : null}
      付费 · 需订阅
    </Badge>
  );
}

export function ModelMetaBadges({ model }: { model: ModelInfo }) {
  const efforts = model.supported_reasoning_efforts ?? model.reasoningEfforts ?? [];
  const tools = model.tools ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {model.reasoning && efforts.length > 0 ? (
        <Badge variant="outline" className="font-normal">
          推理 {efforts.join(' / ')}
        </Badge>
      ) : (
        <Badge variant="muted" className="font-normal">
          无推理档位
        </Badge>
      )}
      {tools.map((tool) => (
        <Badge key={tool} variant="outline" className="font-normal">
          {tool}
        </Badge>
      ))}
      {model.tier ? (
        <Badge variant="outline" className="font-normal">
          {model.tier}
        </Badge>
      ) : null}
    </div>
  );
}

export function LockedModelHint({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center">{children}</span>
      </TooltipTrigger>
      <TooltipContent>
        该模型需要 Duck.ai Plus/Pro 订阅。默认已禁用；可在「设置」中开启 allowPaidModels 后尝试调用。
      </TooltipContent>
    </Tooltip>
  );
}
