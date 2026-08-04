export interface ContextMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TrimmedContext {
  messages: ContextMessage[];
  truncated: boolean;
  estimatedTokens: number;
  budgetTokens: number;
}

/** Deliberately conservative approximation used when providers do not expose a tokenizer. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateMessageTokens(message: ContextMessage): number {
  return estimateTokens(message.content) + 4;
}

export function estimateContextTokens(messages: readonly ContextMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/**
 * Keeps the system prompt and the newest messages while staying near 70% of the
 * configured model context. The newest message is never dropped, even if it is
 * itself larger than the budget; the upstream error then remains actionable.
 */
export function trimContext(
  messages: readonly ContextMessage[],
  contextWindow: number,
  ratio = 0.7,
): TrimmedContext {
  const budgetTokens = Math.max(1, Math.floor(contextWindow * ratio));
  const system = messages.filter((message) => message.role === 'system').slice(0, 1);
  const conversation = messages.filter((message) => message.role !== 'system');
  const kept = conversation.map((message) => ({ ...message }));
  let combined = [...system, ...kept];
  let estimatedTokens = estimateContextTokens(combined);
  let truncated = false;

  while (estimatedTokens > budgetTokens && kept.length > 1) {
    kept.shift();
    combined = [...system, ...kept];
    estimatedTokens = estimateContextTokens(combined);
    truncated = true;
  }

  return { messages: combined, truncated, estimatedTokens, budgetTokens };
}

