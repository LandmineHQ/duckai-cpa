/**
 * POST /v1/images/generations — OpenAI Images API compatible handler.
 *
 * duck.ai exposes image generation through the same chat endpoint; the
 * DuckClient wraps that behind `imageGeneration({prompt, model, signal})`.
 * Response formats:
 *   - { response_format: "b64_json" } (default) → { b64_json }
 *   - { response_format: "url" } → { url: "data:image/<fmt>;base64,<b64>" }
 */

import { resolveModel, modelSupportsTool } from './models.js';
import { badRequest, genId, nowSec } from './errors.js';
import { detectImageFormat, normalizeFormat, imageDataUri, imageMimeType } from '../duck/image-format.js';

const IMAGE_MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
};

function resolveImageModel(config, requestedModel) {
  // Image generation always targets a known duck.ai model; when omitted we use
  // the configured default model (which supports GenerateImage on free tier).
  const resolved = resolveModel(config, requestedModel);
  if (!modelSupportsTool(resolved.model, 'image_generation')) {
    throw badRequest(
      `Model "${resolved.id}" does not support image generation`,
      'model',
      'model_not_supported'
    );
  }
  return resolved;
}

function normalizeImages(result) {
  const list = Array.isArray(result?.images) ? result.images : [];
  const images = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const b64 =
      typeof raw.b64 === 'string'
        ? raw.b64
        : typeof raw.b64Image === 'string'
          ? raw.b64Image
          : typeof raw.b64_json === 'string'
            ? raw.b64_json
            : '';
    if (!b64) continue;
    // duck.ai 实际返回 JPEG，帧里的 format 可能缺失/错误 —— 用魔数探测真实格式
    const format = detectImageFormat(b64, normalizeFormat(raw.format) || 'png');
    images.push({
      b64,
      format,
      ...(Number.isFinite(raw.width) ? { width: raw.width } : {}),
      ...(Number.isFinite(raw.height) ? { height: raw.height } : {}),
      ...(typeof raw.modelDisplayName === 'string' && raw.modelDisplayName
        ? { modelDisplayName: raw.modelDisplayName }
        : {})
    });
  }
  return images;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Record<string, any>} ctx request context built by src/http/server.js
 */
export async function handleImagesGenerations(req, res, ctx) {
  ctx.log.endpoint = 'POST /v1/images/generations';
  const body = ctx.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }

  if (ctx.config?.tools?.imageGeneration === false) {
    throw badRequest('image_generation is disabled in server configuration', 'tools', 'tool_disabled');
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw badRequest('"prompt" is required and must be a non-empty string', 'prompt', 'prompt_required');
  if (prompt.length > 32000) throw badRequest('"prompt" is too long (max 32000 characters)', 'prompt');

  const resolved = resolveImageModel(ctx.config, body.model);
  ctx.log.model = resolved.id;

  let n = 1;
  if (body.n !== undefined && body.n !== null) {
    n = Number(body.n);
    if (!Number.isInteger(n) || n < 1 || n > 4) {
      throw badRequest('"n" must be an integer between 1 and 4', 'n', 'invalid_n');
    }
  }

  const responseFormat = body.response_format === undefined || body.response_format === null
    ? 'b64_json'
    : String(body.response_format);
  if (responseFormat !== 'b64_json' && responseFormat !== 'url') {
    throw badRequest('"response_format" must be "b64_json" or "url"', 'response_format', 'invalid_response_format');
  }

  if (body.size !== undefined && body.size !== null) {
    const size = String(body.size);
    if (size !== 'auto' && !/^\d{2,5}x\d{2,5}$/.test(size)) {
      throw badRequest('"size" must look like "1024x1024" or "auto"', 'size', 'invalid_size');
    }
  }

  const params = {
    prompt,
    model: resolved.id,
    signal: ctx.signal
  };
  if (typeof ctx.selectIdentity === 'function') {
    const paidModel =
      ctx.config?.duck?.allowPaidModels === true && (resolved.paid === true || resolved.model?.paid === true);
    await ctx.selectIdentity({ paidModel });
  }
  const images = [];
  for (let index = 0; index < n; index += 1) {
    const result = await ctx.callUpstream(
      (runtime) => (runtime?.client || ctx.duck).imageGeneration(params),
      { model: resolved.id }
    );
    images.push(...normalizeImages(result));
    if (images.length >= n * 4) break; // defensive cap
  }

  if (images.length === 0) {
    throw badRequest('Upstream returned no image', 'prompt', 'no_image_returned');
  }

  const data = images.slice(0, Math.max(n, 1)).map((image) => {
    const format = detectImageFormat(image.b64, normalizeFormat(image.format) || 'png');
    if (responseFormat === 'url') {
      return { url: imageDataUri(image.b64, format) };
    }
    return {
      b64_json: image.b64,
      // OpenAI 的 Images API 会带 revised_prompt（模型改写后的提示词）；这里回显原始 prompt。
      revised_prompt: prompt,
      format,
      mime_type: imageMimeType(format)
    };
  });

  ctx.json(200, {
    created: nowSec(),
    data,
    // Extensions useful for dashboards / debugging; ignored by OpenAI clients.
    model: resolved.id,
    ...(images[0]?.modelDisplayName ? { model_display_name: images[0].modelDisplayName } : {}),
    response_id: genId('img_')
  });
}
