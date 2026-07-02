import type { KnowledgeResult } from './_knowledge';
import { buildPromptSkills, renderPromptSkills } from './_skills';

export function buildSystemPrompt(knowledge: KnowledgeResult, userMessage: string): string {
  return renderPromptSkills(buildPromptSkills(knowledge, userMessage));
}

export function buildUserInput(message: string, contextText?: string): string {
  if (!contextText?.trim()) return message;
  return [
    message,
    '',
    'User-provided existing configuration or extra context:',
    contextText.trim(),
  ].join('\n');
}
