/**
 * Gateway-side context guard (v2.4, docs/IDENTITY-POOL.md §7).
 *
 * duck.ai limits each input to ~16k chars and long conversations to a server-side
 * maximum (ERR_CONVERSATION_LIMIT / ERR_INPUT_LIMIT). The gateway pre-trims the
 * conversation to `config.context.maxInputChars` / `maxMessages`, keeping the
 * system prompt and the most recent messages, and can retry once with a more
 * aggressive trim when the upstream still rejects the request.
 */

const MIN_MESSAGES = 1;

/**
 * @param {Array<{role:'user'|'assistant', content:string}>} conversation
 * @param {string} systemPrompt
 * @param {{ maxInputChars?: number, maxMessages?: number, aggressive?: boolean }} [options]
 * @returns {{
 *   messages: Array<{role:string, content:string}>,
 *   trimmed: boolean,
 *   droppedMessages: number,
 *   droppedChars: number,
 *   totalMessages: number,
 *   totalChars: number,
 *   systemChars: number
 * }}
 */
export function guardConversation(conversation, systemPrompt = '', options = {}) {
  const source = Array.isArray(conversation) ? conversation : [];
  const systemChars = typeof systemPrompt === 'string' ? systemPrompt.length : 0;
  const configuredChars = Number(options.maxInputChars);
  const configuredMessages = Number(options.maxMessages);
  const scale = options.aggressive === true ? 0.5 : 1;
  const maxChars =
    (Number.isFinite(configuredChars) && configuredChars > 0 ? configuredChars : 12000) *
    scale;
  const maxMessages =
    (Number.isFinite(configuredMessages) && configuredMessages > 0 ? configuredMessages : 40) *
    scale;

  let totalChars = source.reduce((sum, message) => sum + String(message?.content || '').length, 0);
  const selected = [];
  let usedChars = 0;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index];
    const content = typeof message?.content === 'string' ? message.content : '';
    const nextCount = selected.length + 1;
    const nextChars = usedChars + content.length;
    if (nextCount > Math.max(MIN_MESSAGES, Math.floor(maxMessages))) break;
    if (selected.length > 0 && systemChars + nextChars > maxChars) break;
    selected.push({ ...message, role: message.role, content });
    usedChars = nextChars;
  }
  selected.reverse();
  // Always keep at least the most recent message even if it alone exceeds the char budget.
  if (selected.length === 0 && source.length > 0) {
    const last = source[source.length - 1];
    selected.push({ ...last, role: last.role, content: typeof last.content === 'string' ? last.content : '' });
    usedChars = selected[0].content.length;
  }

  const droppedMessages = source.length - selected.length;
  const droppedChars = Math.max(0, totalChars - usedChars);
  return {
    messages: selected,
    trimmed: droppedMessages > 0 || droppedChars > 0,
    droppedMessages,
    droppedChars,
    totalMessages: source.length,
    totalChars,
    systemChars
  };
}

/** Does this error mean "upstream conversation/input limit reached"? */
export function isContextLimitError(error) {
  if (!error) return false;
  const code = String(error.code || error.type || '').toLowerCase();
  const message = String(error.message || '');
  return (
    code === 'conversation_limit_reached' ||
    code === 'err_conversation_limit' ||
    code === 'input_limit_reached' ||
    code === 'err_input_limit' ||
    /maximum chat length|conversation limit|input limit|too long/i.test(message)
  );
}

export default { guardConversation, isContextLimitError };
