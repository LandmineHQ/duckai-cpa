import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckSquare,
  ChevronDown,
  Copy,
  Dices,
  Download,
  Expand,
  ImagePlus,
  Loader2,
  Lock,
  Palette,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X
} from 'lucide-react';
import { toast } from 'sonner';
import { apiDelete, apiGet, apiPost, ApiError } from '@/app/lib/api';
import { formatDateTime, formatDuration } from '@/app/lib/format';
import { readImageFileAsDataUrl } from '@/app/lib/image-upload';
import type {
  GalleryImageItem,
  ImageAspectRatioPreset,
  ImageMoodPreset,
  ImagePresetsResponse,
  ImageStylePreset
} from '@/app/lib/types';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/app/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';

interface GenerateResponse {
  ok: boolean;
  items: GalleryImageItem[];
  composedPrompt: string;
  latencyMs: number;
}

interface GalleryResponse {
  ok: boolean;
  items: GalleryImageItem[];
  total: number;
}

function ratioClass(ratio: string): string {
  switch (ratio) {
    case '16:9':
      return 'aspect-video';
    case '9:16':
      return 'aspect-[9/16]';
    case '4:3':
      return 'aspect-[4/3]';
    case '3:4':
      return 'aspect-[3/4]';
    case '3:2':
      return 'aspect-[3/2]';
    case '21:9':
      return 'aspect-[21/9]';
    default:
      return 'aspect-square';
  }
}

function downloadGalleryImage(item: GalleryImageItem) {
  const a = document.createElement('a');
  a.href = item.dataUrl;
  const ext = item.format === 'jpeg' ? 'jpg' : item.format || 'png';
  a.download = `duckai-${item.id}.${ext}`;
  a.click();
}

export function ImagesPage() {
  const [presets, setPresets] = useState<ImagePresetsResponse | null>(null);
  const [items, setItems] = useState<GalleryImageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Composer state
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState('auto');
  const [aspectRatio, setAspectRatio] = useState('auto');
  const [mood, setMood] = useState('none');
  const [model, setModel] = useState('gpt-6-luna');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [customStyle, setCustomStyle] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [editParent, setEditParent] = useState<GalleryImageItem | null>(null);

  // Gallery filter & selection state
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStyle, setFilterStyle] = useState('all');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [lightboxItem, setLightboxItem] = useState<GalleryImageItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GalleryImageItem | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [presetRes, galleryRes] = await Promise.all([
        apiGet<ImagePresetsResponse>('/images/presets'),
        apiGet<GalleryResponse>('/images/gallery?limit=80')
      ]);
      setPresets(presetRes);
      if (presetRes.models?.length) {
        const usable = presetRes.models.find((m) => m.id === model && m.available)
          || presetRes.models.find((m) => m.available && m.default)
          || presetRes.models.find((m) => m.available);
        if (usable && usable.id !== model) setModel(usable.id);
      }
      setItems(Array.isArray(galleryRes.items) ? galleryRes.items : []);
      setTotal(Number(galleryRes.total || 0));
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '加载图片工坊失败');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!generating) {
      setElapsedSec(0);
      return;
    }
    const timer = window.setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [generating]);

  const styles: ImageStylePreset[] = presets?.styles ?? [];
  const aspectRatios: ImageAspectRatioPreset[] = presets?.aspectRatios ?? [];
  const moods: ImageMoodPreset[] = presets?.moods ?? [];
  const inspirations = presets?.inspirations ?? [];
  const models = presets?.models ?? [];

  const styleMap = useMemo(() => new Map(styles.map((s) => [s.id, s])), [styles]);

  const composedPreview = useMemo(() => {
    const base = prompt.trim();
    if (!base) return '';
    const directives: string[] = [];
    const st = styleMap.get(style);
    if (st?.directive) directives.push(`Style: ${st.directive}`);
    if (customStyle.trim()) directives.push(`Custom: ${customStyle.trim()}`);
    const md = moods.find((m) => m.id === mood);
    if (md?.directive) directives.push(`Lighting: ${md.directive}`);
    const rt = aspectRatios.find((r) => r.id === aspectRatio);
    if (!editParent && !referenceImage && rt?.directive) directives.push(`Framing: ${rt.directive}`);
    if (negativePrompt.trim()) directives.push(`Avoid: ${negativePrompt.trim()}`);
    if (!directives.length) return base;
    return `${editParent || referenceImage ? 'Modify' : 'Generate'}: ${base}\n[${directives.join(' | ')}]`;
  }, [aspectRatio, aspectRatios, customStyle, editParent, mood, moods, negativePrompt, prompt, referenceImage, style, styleMap]);

  const pickInspiration = () => {
    if (!inspirations.length) return;
    const pool = inspirations.filter((text) => text !== prompt);
    const chosen = (pool.length ? pool : inspirations)[Math.floor(Math.random() * (pool.length ? pool.length : inspirations.length))];
    setPrompt(chosen);
  };

  const handleUploadFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const dataUrl = await readImageFileAsDataUrl(file, 1024);
      setReferenceImage(dataUrl);
      setEditParent(null);
      toast.success('已载入参考图片');
    } catch (err) {
      toast.error((err as Error)?.message || '读取参考图失败');
    }
  };

  const generate = async () => {
    const clean = prompt.trim();
    if (!clean) {
      toast.warning('请先输入画面描述提示词');
      return;
    }
    setGenerating(true);
    try {
      const res = await apiPost<GenerateResponse>('/images/generate', {
        prompt: clean,
        style,
        aspectRatio,
        mood,
        model,
        negativePrompt: negativePrompt.trim(),
        customStyle: customStyle.trim(),
        ...(referenceImage ? { referenceImage } : {}),
        ...(editParent ? { parentId: editParent.id } : {})
      });
      const created = Array.isArray(res.items) ? res.items : [];
      if (created.length) {
        setItems((prev) => [...created, ...prev]);
        setTotal((t) => t + created.length);
        toast.success(`生成成功（耗时 ${formatDuration(res.latencyMs)}）`);
      }
      setEditParent(null);
      setReferenceImage(null);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '图片生成失败，请调整提示词后重试');
    } finally {
      setGenerating(false);
    }
  };

  const reuseParams = (item: GalleryImageItem) => {
    setPrompt(item.prompt);
    setStyle(item.style || 'auto');
    setAspectRatio(item.aspectRatio || '1:1');
    setMood(item.mood || 'none');
    setNegativePrompt(item.negativePrompt || '');
    if (item.model && models.some((m) => m.id === item.model && m.available)) {
      setModel(item.model);
    }
    setEditParent(null);
    setReferenceImage(null);
    setLightboxItem(null);
    toast.success('已套用该作品的提示词与参数');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const startEditFrom = (item: GalleryImageItem) => {
    setEditParent(item);
    setReferenceImage(null);
    setPrompt('');
    setStyle(item.style || 'auto');
    setMood(item.mood || 'none');
    if (item.model && models.some((m) => m.id === item.model && m.available)) {
      setModel(item.model);
    }
    setLightboxItem(null);
    toast.info('已切换为「基于此图继续微调」模式，请输入修改要求');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const deleteSingle = async (item: GalleryImageItem) => {
    try {
      await apiDelete(`/images/gallery/${encodeURIComponent(item.id)}`);
      setItems((prev) => prev.filter((x) => x.id !== item.id));
      setTotal((t) => Math.max(0, t - 1));
      if (lightboxItem?.id === item.id) setLightboxItem(null);
      setDeleteTarget(null);
      toast.success('已从画廊删除');
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '删除失败');
    }
  };

  const bulkDelete = async () => {
    const ids = Object.entries(selectedIds)
      .filter(([, checked]) => checked)
      .map(([id]) => id);
    if (!ids.length) return;
    try {
      await apiPost('/images/gallery/bulk-delete', { ids });
      const removeSet = new Set(ids);
      setItems((prev) => prev.filter((x) => !removeSet.has(x.id)));
      setTotal((t) => Math.max(0, t - ids.length));
      setSelectedIds({});
      setSelectMode(false);
      toast.success(`已删除 ${ids.length} 张作品`);
    } catch (err) {
      if ((err as ApiError)?.handled) return;
      toast.error((err as Error)?.message || '批量删除失败');
    }
  };

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      if (filterStyle !== 'all' && item.style !== filterStyle) return false;
      if (q && !item.prompt.toLowerCase().includes(q) && !item.composedPrompt.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [filterStyle, items, searchQuery]);

  const selectedModelMeta = models.find((m) => m.id === model);
  const selectedRatioMeta = aspectRatios.find((r) => r.id === aspectRatio);
  const selectedMoodMeta = moods.find((m) => m.id === mood);
  const selectedCount = Object.values(selectedIds).filter(Boolean).length;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Studio Hero Composer (ChatGPT Images style) */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary">
              <Sparkles className="h-3 w-3" />
              ChatGPT Images 风格工坊
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">描述你想看到的画面</h1>
            <p className="text-sm text-muted-foreground">
              通过提示词引导视觉风格、构图画幅与光影氛围，严格保持 duck.ai 原生 GenerateImage 协议
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={pickInspiration} className="gap-1.5">
            <Dices className="h-3.5 w-3.5 text-primary" />
            随机灵感
          </Button>
        </div>

        {(editParent || referenceImage) ? (
          <div className="flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-3">
            <img
              src={editParent ? editParent.dataUrl : referenceImage || ''}
              alt="参考图"
              className="h-14 w-14 rounded-xl border object-cover"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                <Wand2 className="h-3.5 w-3.5" />
                {editParent ? '基于画廊作品继续微调（保留 generated-image 完整上下文）' : '已上传参考图片（图生图）'}
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {editParent ? `原图提示词：${editParent.prompt}` : '请在下方输入希望如何改造这张参考图'}
              </p>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 shrink-0"
              aria-label="取消参考图"
              onClick={() => {
                setEditParent(null);
                setReferenceImage(null);
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : null}

        <Card className="overflow-hidden rounded-3xl border-border/80 shadow-sm focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/15">
          <div className="p-4 pb-2">
            <Textarea
              value={prompt}
              rows={3}
              placeholder={
                editParent
                  ? '输入你想微调的细节，例如：把背景换成日落海边，保留主体橘猫并增加温暖逆光…'
                  : '描述画面主体、场景环境、材质细节与氛围，例如：一只系着橙色丝巾的柴犬站在东京雨夜街头，电影级光影…'
              }
              className="min-h-[84px] resize-none border-0 bg-transparent p-0 text-[15px] leading-relaxed shadow-none focus-visible:ring-0"
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void generate();
                }
              }}
              disabled={generating}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-muted/20 px-4 py-2.5">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                void handleUploadFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 rounded-full text-xs"
              disabled={generating}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5" />
              参考图
            </Button>

            {/* 模型选择 */}
            <Select value={model} onValueChange={setModel} disabled={generating || models.length === 0}>
              <SelectTrigger className="h-8 w-[180px] rounded-full text-xs">
                <span className="truncate">{selectedModelMeta?.name || model}</span>
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id} disabled={!m.available}>
                    <div className="flex items-center gap-2">
                      <SelectItemText>{m.name}</SelectItemText>
                      {!m.available ? <Lock className="h-3 w-3 text-muted-foreground" /> : null}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* 画幅比例选择 */}
            <Select value={aspectRatio} onValueChange={setAspectRatio} disabled={generating}>
              <SelectTrigger className="h-8 w-[135px] rounded-full text-xs">
                <span className="truncate">{selectedRatioMeta?.label || aspectRatio}</span>
              </SelectTrigger>
              <SelectContent>
                {aspectRatios.map((ratio) => (
                  <SelectItem key={ratio.id} value={ratio.id}>
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block shrink-0 rounded-[2px] border border-primary/60 bg-primary/15"
                        style={{ width: `${Math.round(ratio.width * 0.7)}px`, height: `${Math.round(ratio.height * 0.7)}px` }}
                      />
                      <SelectItemText>{ratio.label}</SelectItemText>
                      <span className="text-[10px] text-muted-foreground">{ratio.hint}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* 光影氛围 */}
            <Select value={mood} onValueChange={setMood} disabled={generating}>
              <SelectTrigger className="h-8 w-[130px] rounded-full text-xs">
                <span className="truncate">{selectedMoodMeta?.label || '光影氛围'}</span>
              </SelectTrigger>
              <SelectContent>
                {moods.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <SelectItemText>{m.label}</SelectItemText>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              type="button"
              size="sm"
              variant={advancedOpen ? 'secondary' : 'ghost'}
              className="h-8 gap-1 rounded-full text-xs text-muted-foreground"
              onClick={() => setAdvancedOpen((v) => !v)}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              高级
              <ChevronDown className={cn('h-3 w-3 transition-transform', advancedOpen && 'rotate-180')} />
            </Button>

            <div className="ml-auto flex items-center gap-2">
              <span className="hidden text-[11px] text-muted-foreground sm:inline">Ctrl + Enter 生成</span>
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1.5 rounded-full px-4 text-xs font-medium shadow-xs"
                disabled={generating || !prompt.trim()}
                onClick={() => void generate()}
              >
                {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
                {generating ? `创作中 ${elapsedSec}s` : editParent ? '生成微调' : '生成图片'}
              </Button>
            </div>
          </div>

          {advancedOpen ? (
            <div className="space-y-3 border-t border-border/60 bg-muted/10 p-4 text-xs">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="img-negative" className="text-xs">排除元素 / Negative Guidance</Label>
                  <Input
                    id="img-negative"
                    placeholder="例如：文字水印、模糊边缘、多余手指"
                    value={negativePrompt}
                    onChange={(e) => setNegativePrompt(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="img-custom-style" className="text-xs">补充风格/镜头描述</Label>
                  <Input
                    id="img-custom-style"
                    placeholder="例如：85mm f/1.4, Kodak Portra 400"
                    value={customStyle}
                    onChange={(e) => setCustomStyle(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
              </div>
              {composedPreview ? (
                <div className="rounded-lg border bg-background/80 p-2.5">
                  <div className="mb-1 text-[10.5px] font-medium text-muted-foreground">将发送给 GenerateImage 的完整引导提示词：</div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/85">{composedPreview}</pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>

        {/* Style Presets Strip */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Palette className="h-3.5 w-3.5 text-primary" />
            提示词引导风格预设（点击切换）
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {styles.map((preset) => {
              const active = style === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setStyle(preset.id)}
                  className={cn(
                    'group relative overflow-hidden rounded-xl border p-2.5 text-left transition-all',
                    active
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/40 shadow-xs'
                      : 'border-border/70 bg-card hover:border-primary/40'
                  )}
                >
                  <div className={cn('mb-1.5 h-8 w-full rounded-lg bg-gradient-to-br', preset.gradient)} />
                  <div className="truncate text-xs font-semibold">{preset.label}</div>
                  <div className="line-clamp-1 text-[10.5px] text-muted-foreground">{preset.description}</div>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Gallery Section */}
      <section className="space-y-3 border-t border-border/70 pt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">我的画廊</h2>
            <Badge variant="muted" className="tabular-nums">{total} 张作品</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索提示词…"
                className="h-8 w-44 pl-8 text-xs sm:w-56"
              />
            </div>
            <Select value={filterStyle} onValueChange={setFilterStyle}>
              <SelectTrigger className="h-8 w-32 text-xs">
                <span className="truncate">
                  {filterStyle === 'all' ? '全部风格' : (styleMap.get(filterStyle)?.label || filterStyle)}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  <SelectItemText>全部风格</SelectItemText>
                </SelectItem>
                {styles.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <SelectItemText>{s.label}</SelectItemText>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant={selectMode ? 'secondary' : 'outline'}
              className="h-8 gap-1 text-xs"
              onClick={() => {
                setSelectMode((v) => !v);
                setSelectedIds({});
              }}
            >
              <CheckSquare className="h-3.5 w-3.5" />
              {selectMode ? '取消多选' : '批量管理'}
            </Button>
            {selectMode && selectedCount > 0 ? (
              <Button size="sm" variant="destructive" className="h-8 gap-1 text-xs" onClick={() => void bulkDelete()}>
                <Trash2 className="h-3.5 w-3.5" />
                删除 {selectedCount} 张
              </Button>
            ) : null}
            <Button size="icon" variant="outline" className="h-8 w-8" aria-label="刷新画廊" onClick={() => void loadAll()}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </Button>
          </div>
        </div>

        {loading && items.length === 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded-2xl" />)}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {generating ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-primary/50 bg-primary/5 p-6 text-center">
                <div className={cn('flex w-full max-w-[180px] flex-col items-center justify-center rounded-xl bg-primary/10', ratioClass(aspectRatio))}>
                  <Loader2 className="h-7 w-7 animate-spin text-primary" />
                  <span className="mt-2 text-xs font-medium text-primary tabular-nums">正在绘制 · {elapsedSec}s</span>
                </div>
                <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">{prompt}</p>
              </div>
            ) : null}

            {filteredItems.map((item) => {
              const checked = selectedIds[item.id] === true;
              const styleLabel = styleMap.get(item.style)?.label || item.style;
              return (
                <Card
                  key={item.id}
                  className={cn(
                    'group relative overflow-hidden rounded-2xl border-border/80 transition-all hover:shadow-md',
                    checked && 'ring-2 ring-primary'
                  )}
                >
                  <div
                    className="relative cursor-pointer overflow-hidden bg-muted/30"
                    onClick={() => {
                      if (selectMode) {
                        setSelectedIds((prev) => ({ ...prev, [item.id]: !prev[item.id] }));
                      } else {
                        setLightboxItem(item);
                      }
                    }}
                  >
                    <img
                      src={item.dataUrl}
                      alt={item.prompt}
                      className="aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                      loading="lazy"
                    />
                    {selectMode ? (
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setSelectedIds((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute left-2.5 top-2.5 h-4 w-4 accent-primary"
                      />
                    ) : (
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/75 via-black/30 to-transparent p-3 pt-8 opacity-0 transition-opacity group-hover:opacity-100">
                        <span className="line-clamp-2 text-[11px] font-medium text-white">{item.prompt}</span>
                        <Expand className="ml-2 h-4 w-4 shrink-0 text-white/90" />
                      </div>
                    )}
                  </div>
                  <div className="space-y-2 p-2.5">
                    <div className="flex flex-wrap items-center gap-1">
                      {item.style && item.style !== 'auto' ? (
                        <Badge variant="accent" className="px-1.5 py-0 text-[10px]">{styleLabel}</Badge>
                      ) : null}
                      {item.aspectRatio ? (
                        <Badge variant="mono" className="px-1.5 py-0 text-[10px]">{item.aspectRatio}</Badge>
                      ) : null}
                      <span className="ml-auto font-mono text-[10px] text-muted-foreground">{item.model}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 flex-1 px-1.5 text-[11px]"
                        onClick={() => reuseParams(item)}
                      >
                        同款参数
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 flex-1 px-1.5 text-[11px] text-primary"
                        onClick={() => startEditFrom(item)}
                      >
                        继续微调
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-muted-foreground"
                        aria-label="下载图片"
                        onClick={() => downloadGalleryImage(item)}
                      >
                        <Download className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        aria-label="删除图片"
                        onClick={() => setDeleteTarget(item)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        {!loading && !generating && filteredItems.length === 0 ? (
          <div className="rounded-2xl border border-dashed py-12 text-center text-sm text-muted-foreground">
            {items.length === 0 ? '画廊还是空的，在上方输入提示词创作第一张图片吧！' : '没有符合当前筛选条件的作品'}
          </div>
        ) : null}
      </section>

      {/* Lightbox Dialog */}
      <Dialog open={Boolean(lightboxItem)} onOpenChange={(open) => { if (!open) setLightboxItem(null); }}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto p-0">
          {lightboxItem ? (
            <div className="grid md:grid-cols-[1.35fr_1fr]">
              <div className="flex items-center justify-center bg-black/90 p-4">
                <img
                  src={lightboxItem.dataUrl}
                  alt={lightboxItem.prompt}
                  className="max-h-[75vh] w-auto rounded-lg object-contain"
                />
              </div>
              <div className="flex flex-col justify-between space-y-4 p-5">
                <div className="space-y-3">
                  <DialogHeader>
                    <DialogTitle className="text-base">作品详情</DialogTitle>
                    <DialogDescription>
                      {formatDateTime(lightboxItem.createdAt)}
                      {lightboxItem.latencyMs ? ` · 耗时 ${formatDuration(lightboxItem.latencyMs)}` : ''}
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-1">
                    <div className="text-[11px] font-medium text-muted-foreground">原始提示词</div>
                    <p className="rounded-lg border bg-muted/25 p-2.5 text-xs leading-relaxed">{lightboxItem.prompt}</p>
                  </div>
                  {lightboxItem.composedPrompt !== lightboxItem.prompt ? (
                    <details>
                      <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                        查看实际发送提示词（含风格与画幅引导）
                      </summary>
                      <pre className="mt-1.5 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/20 p-2 font-mono text-[10.5px]">
                        {lightboxItem.composedPrompt}
                      </pre>
                    </details>
                  ) : null}
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline" className="font-mono text-[10.5px]">{lightboxItem.model}</Badge>
                    <Badge variant="accent" className="text-[10.5px]">
                      {styleMap.get(lightboxItem.style)?.label || lightboxItem.style}
                    </Badge>
                    <Badge variant="mono" className="text-[10.5px]">{lightboxItem.aspectRatio}</Badge>
                    {lightboxItem.width && lightboxItem.height ? (
                      <Badge variant="muted" className="text-[10.5px]">{lightboxItem.width}×{lightboxItem.height}</Badge>
                    ) : null}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 border-t pt-3">
                  <Button variant="outline" size="sm" onClick={() => downloadGalleryImage(lightboxItem)}>
                    <Download className="h-3.5 w-3.5" />
                    下载原图
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard?.writeText(lightboxItem.prompt);
                      toast.success('已复制提示词');
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    复制提示词
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => reuseParams(lightboxItem)}>
                    同款参数
                  </Button>
                  <Button size="sm" onClick={() => startEditFrom(lightboxItem)}>
                    <Wand2 className="h-3.5 w-3.5" />
                    基于此图微调
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="col-span-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setDeleteTarget(lightboxItem)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    从画廊删除
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => (!open ? setDeleteTarget(null) : null)}
        title="删除画廊作品？"
        description="将从 SQLite 画廊永久删除该图片，此操作不可撤销。"
        confirmText="删除"
        destructive
        onConfirm={() => (deleteTarget ? void deleteSingle(deleteTarget) : undefined)}
      />
    </div>
  );
}
