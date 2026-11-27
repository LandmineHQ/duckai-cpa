/**
 * 图片工坊 Admin API (/admin/api/images/*):
 *   GET    /admin/api/images/presets
 *   GET    /admin/api/images/gallery
 *   GET    /admin/api/images/gallery/:id
 *   DELETE /admin/api/images/gallery/:id
 *   POST   /admin/api/images/gallery/bulk-delete
 *   POST   /admin/api/images/generate
 */
import { adminCatalogItems, isPaidModel, modelSupportsTool, resolveModel } from '../../openai/models.js';
import {
  composeImagePrompt,
  IMAGE_ASPECT_RATIOS,
  IMAGE_INSPIRATIONS,
  IMAGE_MOOD_PRESETS,
  IMAGE_STYLE_PRESETS
} from '../../openai/image-prompt.js';
import { normalizeMessageImages } from '../../openai/image-context.js';
import { detectImageFormat, normalizeFormat } from '../../duck/image-format.js';
import { badRequest, notFound, OpenAIError } from '../../openai/errors.js';
import { requireMethod } from './helpers.js';

function ensureGallery(ctx) {
  if (!ctx.imageGallery) {
    throw new OpenAIError('图片画廊存储不可用（SQLite 未就绪）', {
      status: 503,
      type: 'server_error',
      code: 'image_gallery_unavailable'
    });
  }
  return ctx.imageGallery;
}

export async function handleImagesAdmin(ctx, parts, method, route) {
  if (parts.length === 2 && parts[1] === 'presets') {
    requireMethod(ctx, ['GET', 'HEAD']);
    const catalog = adminCatalogItems(ctx.config);
    const models = catalog
      .filter((m) => m?.capabilities?.imageGeneration === true)
      .map((m) => ({
        id: m.id,
        name: m.name,
        paid: Boolean(m.paid),
        tier: m.tier || (m.paid ? 'paid' : 'free'),
        available: m.available !== false,
        default: Boolean(m.default)
      }));
    ctx.json(200, {
      ok: true,
      styles: IMAGE_STYLE_PRESETS,
      aspectRatios: IMAGE_ASPECT_RATIOS,
      moods: IMAGE_MOOD_PRESETS,
      inspirations: IMAGE_INSPIRATIONS,
      models
    });
    return;
  }

  if (parts.length >= 2 && parts[1] === 'gallery') {
    const gallery = ensureGallery(ctx);
    if (parts.length === 2) {
      requireMethod(ctx, ['GET', 'HEAD']);
      const list = await gallery.list({
        limit: Number(ctx.query.get('limit')) || 60,
        offset: Number(ctx.query.get('offset')) || 0,
        style: ctx.query.get('style') || null,
        model: ctx.query.get('model') || null,
        q: ctx.query.get('q') || null
      });
      const stats = await gallery.stats();
      ctx.json(200, { ok: true, ...list, stats });
      return;
    }
    if (parts.length === 3 && parts[2] === 'bulk-delete') {
      requireMethod(ctx, ['POST']);
      const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
      const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string' && id) : [];
      if (!ids.length) throw badRequest('"ids" must be a non-empty array', 'ids', 'ids_required');
      const result = await gallery.bulkRemove(ids);
      ctx.json(200, { ok: true, ...result });
      return;
    }
    if (parts.length === 3) {
      const id = decodeURIComponent(parts[2]);
      if (ctx.method === 'DELETE') {
        const deleted = await gallery.remove(id);
        if (!deleted) throw notFound(`Image "${id}" not found`, 'image_not_found');
        ctx.json(200, { ok: true, deleted: true, id });
        return;
      }
      requireMethod(ctx, ['GET', 'HEAD']);
      const item = await gallery.get(id);
      if (!item) throw notFound(`Image "${id}" not found`, 'image_not_found');
      ctx.json(200, { ok: true, item });
      return;
    }
  }

  if (parts.length === 2 && parts[1] === 'generate') {
    requireMethod(ctx, ['POST']);
    const gallery = ensureGallery(ctx);
    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) throw badRequest('"prompt" 不能为空', 'prompt', 'prompt_required');
    if (prompt.length > 16000) throw badRequest('"prompt" 过长（最多 16000 字符）', 'prompt');

    const resolved = resolveModel(ctx.config, body.model);
    if (!modelSupportsTool(resolved.model, 'image_generation')) {
      throw badRequest(`模型 "${resolved.id}" 不支持图片生成`, 'model', 'model_not_supported');
    }

    const style = typeof body.style === 'string' && body.style.trim() ? body.style.trim() : 'auto';
    const aspectRatio = typeof body.aspectRatio === 'string' && body.aspectRatio.trim() ? body.aspectRatio.trim() : '1:1';
    const mood = typeof body.mood === 'string' && body.mood.trim() ? body.mood.trim() : 'none';
    const negativePrompt = typeof body.negativePrompt === 'string' ? body.negativePrompt.trim() : '';
    const customStyle = typeof body.customStyle === 'string' ? body.customStyle.trim() : '';
    const parentId = typeof body.parentId === 'string' && body.parentId.trim() ? body.parentId.trim() : null;

    let parentRecord = null;
    if (parentId) {
      parentRecord = await gallery.get(parentId);
      if (!parentRecord) throw notFound(`参考作品 "${parentId}" 不存在`, 'parent_not_found');
    }

    const refImages = body.referenceImage
      ? normalizeMessageImages([{ dataUrl: String(body.referenceImage) }])
      : Array.isArray(body.images)
        ? normalizeMessageImages(body.images)
        : [];

    const composedPrompt = composeImagePrompt({
      prompt,
      style,
      aspectRatio,
      mood,
      negativePrompt,
      customStyle,
      isEdit: Boolean(parentRecord || refImages.length)
    });

    // 严格遵守 duck.ai 请求结构：所有风格与画幅均经由自然语言 prompt 传达，不往 upstream body 添任何非标字段
    let messages;
    if (parentRecord) {
      messages = [
        { role: 'user', content: parentRecord.composedPrompt || parentRecord.prompt },
        {
          role: 'assistant',
          content: '',
          images: [
            {
              kind: 'generated',
              b64: parentRecord.b64,
              format: parentRecord.format,
              ...(parentRecord.upstreamImageId ? { id: parentRecord.upstreamImageId } : {}),
              ...(parentRecord.moderationToken ? { moderationToken: parentRecord.moderationToken } : {}),
              ...(Number.isFinite(parentRecord.width) ? { width: parentRecord.width } : {}),
              ...(Number.isFinite(parentRecord.height) ? { height: parentRecord.height } : {})
            }
          ]
        },
        {
          role: 'user',
          content: composedPrompt,
          ...(refImages.length ? { images: refImages } : {})
        }
      ];
    } else {
      messages = [
        {
          role: 'user',
          content: composedPrompt,
          ...(refImages.length ? { images: refImages } : {})
        }
      ];
    }

    ctx.log.endpoint = 'POST /admin/api/images/generate';
    ctx.log.model = resolved.id;
    ctx.log.promptChars = composedPrompt.length;

    const paidModel = isPaidModel(resolved.id);
    if (typeof ctx.selectIdentity === 'function') {
      await ctx.selectIdentity({ paidModel, rebindPaid: true });
    }

    const startedAt = Date.now();
    ctx.beginJsonKeepalive?.();
    const upstreamResult = await ctx.callUpstream(
      (runtime) =>
        (runtime?.client || ctx.duck).chat(
          {
            model: resolved.id,
            messages,
            imageGeneration: true,
            reasoningEffort: 'none',
            approxLocation: false,
            signal: ctx.signal
          },
          {
            onUpstreamAccepted: () => {
              ctx.markJsonKeepaliveAccepted?.();
            }
          }
        ),
      { model: resolved.id, source: 'admin-image-studio' }
    );

    const rawImages = Array.isArray(upstreamResult?.images) ? upstreamResult.images : [];
    if (!rawImages.length) {
      throw badRequest('上游未返回生成图片，请调整提示词后重试', 'prompt', 'no_image_returned');
    }

    const latencyMs = Date.now() - startedAt;
    const savedItems = [];
    for (const img of rawImages) {
      if (!img || !img.b64) continue;
      const format = detectImageFormat(img.b64, normalizeFormat(img.format) || 'png');
      const saved = await gallery.save({
        prompt,
        composedPrompt,
        style,
        aspectRatio,
        mood,
        negativePrompt,
        model: resolved.id,
        modelDisplayName: img.modelDisplayName || upstreamResult.modelDisplayName || null,
        identityId: ctx.log.identityId ?? null,
        identityLabel: ctx.log.identityLabel ?? null,
        format,
        width: img.width,
        height: img.height,
        b64: img.b64,
        upstreamImageId: img.id || null,
        moderationToken: img.moderationToken || null,
        parentId: parentRecord?.id || null,
        latencyMs
      });
      if (saved) savedItems.push(saved);
    }

    ctx.recordUpstream?.({
      endpoint: 'POST /admin/api/images/generate',
      status: 200,
      model: resolved.id,
      latencyMs,
      stream: false,
      identityId: ctx.log.identityId ?? null,
      identityLabel: ctx.log.identityLabel ?? null
    });

    ctx.json(200, {
      ok: true,
      items: savedItems,
      composedPrompt,
      style,
      aspectRatio,
      mood,
      model: resolved.id,
      latencyMs,
      identityId: ctx.log.identityId ?? null,
      identityLabel: ctx.log.identityLabel ?? null
    });
    return;
  }

  throw notFound(`Unknown admin endpoint: ${method} ${route}`);
}

export default { handleImagesAdmin };
