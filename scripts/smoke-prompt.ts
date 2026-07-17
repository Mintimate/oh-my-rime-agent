import { buildSystemPrompt } from '../agents/chat/_prompt';

const selectCharacterPrompt = buildSystemPrompt(
  { available: true, hits: [] },
  '什么是以词定字？',
);

assertIncludes(selectCharacterPrompt, 'lua_processor@*select_character');
assertIncludes(selectCharacterPrompt, 'key_binder/select_first_character');
assertIncludes(selectCharacterPrompt, 'key_binder/select_last_character');
assertIncludes(selectCharacterPrompt, '[');
assertIncludes(selectCharacterPrompt, ']');

assertIncludes(selectCharacterPrompt, 'every path entry must start with exactly two spaces');
assertIncludes(selectCharacterPrompt, 'Treat CNB knowledge-base context as the primary evidence source');
assertIncludes(selectCharacterPrompt, 'this scenario is currently unsupported');

console.log('Prompt smoke passed.');

function assertIncludes(text: string, expected: string) {
  if (!text.includes(expected)) {
    throw new Error(`expected prompt to include ${expected}`);
  }
}
