/**
 * 图片工坊（ChatGPT Images 风格）提示词引导引擎。
 *
 * duck.ai 上游 POST /duckchat/v1/chat 不接受非标 `style` / `aspect_ratio` / `size` 等 body 字段，
 * 因此风格、画幅比例、光影氛围与排除描述统一通过结构化提示词引导实现，保证上游契约 100% 严格。
 */

export const IMAGE_STYLE_PRESETS = Object.freeze([
  {
    id: 'auto',
    label: '智能默认',
    description: '尊重原始描述自由发挥',
    directive: '',
    gradient: 'from-orange-500/20 via-amber-500/15 to-rose-500/20'
  },
  {
    id: 'photorealistic',
    label: '写实摄影',
    description: '自然光学质感、浅景深真实摄影',
    directive: 'Photorealistic 35mm editorial photography, natural lighting, sharp focus, subtle depth of field, authentic textures, lifelike detail',
    gradient: 'from-stone-600/30 via-amber-600/20 to-stone-800/30'
  },
  {
    id: 'cinematic',
    label: '电影质感',
    description: '变形宽银幕光影与叙事胶片色调',
    directive: 'Cinematic film still, anamorphic lens flare, dramatic three-point lighting, rich color grading, 35mm film grain, atmospheric depth',
    gradient: 'from-slate-700/35 via-amber-500/20 to-indigo-900/30'
  },
  {
    id: 'anime',
    label: '日系动漫',
    description: '精致赛璐璐线条与通透色彩光影',
    directive: 'High-quality Japanese anime illustration, clean expressive linework, vibrant cel shading, luminous eyes and sky lighting, modern anime key visual',
    gradient: 'from-sky-500/25 via-indigo-500/20 to-pink-500/25'
  },
  {
    id: 'ghibli',
    label: '温暖手绘',
    description: '童话感水彩动画风景与治愈氛围',
    directive: 'Warm hand-painted storybook animation style, lush whimsical scenery, soft painterly clouds, nostalgic sunlit atmosphere, delicate gouache brush strokes',
    gradient: 'from-emerald-500/25 via-amber-400/20 to-sky-400/25'
  },
  {
    id: 'watercolor',
    label: '水彩插画',
    description: '冷压画纸晕染笔触与轻盈留白',
    directive: 'Delicate watercolor painting on textured cold-press cotton paper, translucent wet-on-wet pigment washes, expressive ink outlines, artistic negative space',
    gradient: 'from-cyan-400/25 via-rose-300/25 to-amber-300/25'
  },
  {
    id: 'cyberpunk',
    label: '赛博霓虹',
    description: '雨夜霓虹反射、未来科幻都会',
    directive: 'Cyberpunk sci-fi concept art, rain-slicked neon streets, volumetric holographic reflections, high-contrast teal and orange/magenta glow, intricate futuristic detail',
    gradient: 'from-fuchsia-600/30 via-cyan-500/25 to-violet-900/30'
  },
  {
    id: '3d-render',
    label: '3D 盲盒',
    description: '柔焦微距黏土质感与棚拍漫反射',
    directive: 'Cute tactile 3D stylized Octane render, soft matte clay and frosted glass materials, studio global illumination, miniature tilt-shift feel, playful proportions',
    gradient: 'from-orange-400/30 via-pink-400/25 to-purple-400/25'
  },
  {
    id: 'minimal-vector',
    label: '极简矢量',
    description: '现代几何构图、干净留白与扁平配色',
    directive: 'Minimalist modern flat vector illustration, clean geometric silhouettes, harmonious limited color palette, crisp edges, balanced graphic composition',
    gradient: 'from-amber-400/30 via-orange-300/20 to-yellow-200/30'
  },
  {
    id: 'oil-painting',
    label: '古典油画',
    description: '厚涂肌理笔触与伦勃朗式明暗对比',
    directive: 'Classical fine art oil painting on canvas, rich impasto brushstrokes, dramatic chiaroscuro museum lighting, warm golden undertones, gallery masterpiece quality',
    gradient: 'from-amber-800/35 via-yellow-600/25 to-stone-900/35'
  },
  {
    id: 'chinese-ink',
    label: '水墨国风',
    description: '宣纸意境留白与传统丹青韵味',
    directive: 'Traditional Chinese ink wash painting (Shuimo), rice paper texture, flowing calligraphic brushwork, poetic mist and mountain depth, restrained vermilion seal accent',
    gradient: 'from-zinc-700/30 via-stone-400/25 to-red-700/20'
  },
  {
    id: 'pixel-art',
    label: '复古像素',
    description: '16-bit 精致像素点阵与游戏美术',
    directive: 'Crisp handcrafted 16-bit pixel art, curated retro color palette, clean dithering shading, charming indie game sprite environment',
    gradient: 'from-violet-500/30 via-emerald-500/20 to-amber-500/25'
  }
]);

export const IMAGE_ASPECT_RATIOS = Object.freeze([
  { id: 'auto', label: '智能画幅', short: 'Auto', hint: '自动匹配最佳构图', width: 16, height: 16, directive: '' },
  { id: '1:1', label: '1:1 方形', short: '1:1', hint: '头像 / 封面通用', width: 16, height: 16, directive: 'square 1:1 aspect ratio, centered balanced framing' },
  { id: '16:9', label: '16:9 横屏', short: '16:9', hint: '壁纸 / 电影宽画幅', width: 22, height: 13, directive: 'wide 16:9 landscape aspect ratio, expansive horizontal framing' },
  { id: '9:16', label: '9:16 竖屏', short: '9:16', hint: '手机壁纸 / 海报', width: 13, height: 22, directive: 'tall 9:16 vertical portrait aspect ratio, full-height vertical composition' },
  { id: '4:3', label: '4:3 横构图', short: '4:3', hint: '经典摄影 / 展示', width: 20, height: 15, directive: 'classic 4:3 horizontal aspect ratio, harmonious framing' },
  { id: '3:4', label: '3:4 竖构图', short: '3:4', hint: '人像 / 插画卡片', width: 15, height: 20, directive: '3:4 vertical portrait aspect ratio, well-framed subject' },
  { id: '3:2', label: '3:2 相机', short: '3:2', hint: '单反纪实画幅', width: 21, height: 14, directive: '3:2 DSLR photographic aspect ratio, rule-of-thirds composition' },
  { id: '21:9', label: '21:9 超宽', short: '21:9', hint: '史诗全景银幕', width: 24, height: 11, directive: 'ultra-wide 21:9 panoramic cinema aspect ratio, sweeping vista' }
]);

export const IMAGE_MOOD_PRESETS = Object.freeze([
  { id: 'none', label: '默认光影', directive: '' },
  { id: 'golden-hour', label: '日落暖金', directive: 'warm golden hour sunlight, soft long shadows, amber rim light' },
  { id: 'studio-soft', label: '棚拍柔光', directive: 'clean softbox studio lighting, smooth gradients, balanced highlights' },
  { id: 'neon-night', label: '赛博夜色', directive: 'moody nocturnal lighting, vivid neon accents, wet reflections' },
  { id: 'dramatic', label: '戏剧明暗', directive: 'high-contrast dramatic chiaroscuro lighting, deep shadows, spotlight focus' },
  { id: 'pastel', label: '清新粉彩', directive: 'soft dreamy pastel color palette, airy diffused morning light' }
]);

export const IMAGE_INSPIRATIONS = Object.freeze([
  '一只戴着复古飞行员墨镜、系着橙色丝巾的柴犬站在东京雨夜十字路口',
  '漂浮在云海之上的空中温室图书馆，阳光透过彩色玻璃穹顶洒满蕨类植物',
  '极简北欧风咖啡角落，清晨阳光斜照在陶瓷手冲壶与冒热气的拿铁上',
  '赛博朋克风格的深夜拉面摊，蒸汽与全息霓虹灯牌在湿润石板路上倒映',
  '水墨留白山水之间，一叶扁舟穿过晨雾缭绕的漓江孤峰',
  '3D 黏土微缩世界：一座建在巨型橘子上的童话烘焙坊，窗内透出温暖灯光'
]);

const STYLE_MAP = new Map(IMAGE_STYLE_PRESETS.map((s) => [s.id, s]));
const RATIO_MAP = new Map(IMAGE_ASPECT_RATIOS.map((r) => [r.id, r]));
const MOOD_MAP = new Map(IMAGE_MOOD_PRESETS.map((m) => [m.id, m]));

/**
 * 将用户的自然语言描述、风格预设、画幅比例、光影与排除提示组合成发给 duck.ai 的单段提示词。
 */
export function composeImagePrompt({
  prompt = '',
  style = 'auto',
  aspectRatio = 'auto',
  mood = 'none',
  negativePrompt = '',
  customStyle = '',
  isEdit = false
} = {}) {
  const base = String(prompt || '').trim();
  if (!base) return '';

  const stylePreset = STYLE_MAP.get(String(style || 'auto')) || STYLE_MAP.get('auto');
  const ratioPreset = RATIO_MAP.get(String(aspectRatio || 'auto'));
  const moodPreset = MOOD_MAP.get(String(mood || 'none'));
  const neg = String(negativePrompt || '').trim();
  const extraStyle = String(customStyle || '').trim();

  const directives = [];
  if (stylePreset?.directive) directives.push(`Style: ${stylePreset.directive}`);
  if (extraStyle) directives.push(`Custom aesthetic: ${extraStyle}`);
  if (moodPreset?.directive) directives.push(`Lighting & mood: ${moodPreset.directive}`);
  if (!isEdit && ratioPreset?.directive) directives.push(`Framing: ${ratioPreset.directive}`);
  if (neg) directives.push(`Avoid: ${neg}`);

  if (!directives.length) return base;
  const prefix = isEdit ? 'Modify the previous image based on this instruction' : 'Generate an image';
  return `${prefix}: ${base}\n\n[${directives.join(' | ')}]`;
}

export default {
  IMAGE_STYLE_PRESETS,
  IMAGE_ASPECT_RATIOS,
  IMAGE_MOOD_PRESETS,
  IMAGE_INSPIRATIONS,
  composeImagePrompt
};
