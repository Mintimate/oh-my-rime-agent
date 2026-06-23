import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tool } from '@openai/agents';
import { onRequest } from '../agents/chat/index';

const env = readDotEnv('.env');
env.ENABLE_PLATFORM_TOOLS = 'true';

const weather = tool({
  name: 'get_weather',
  description: 'Get weather for a city',
  strict: false,
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  execute: async ({ city }) => `Weather in ${city}: sunny, 22C`,
});

const response = await onRequest({
  conversation_id: randomUUID(),
  request: {
    body: { message: '请调用天气工具查询北京天气，然后简短回答。' },
    signal: new AbortController().signal,
    headers: {},
  },
  env,
  tools: { all: () => [weather] },
});

if (!response.body) {
  console.log(`HTTP ${response.status}: ${await response.text()}`);
  process.exit(1);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let toolCalled = false;
let toolOutput = false;
let answer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  const frames = buffer.split('\n\n');
  buffer = frames.pop() ?? '';

  for (const frame of frames) {
    const line = frame.trim();
    if (!line.startsWith('data: ')) continue;

    const payload = line.slice(6);
    if (payload === '[DONE]') {
      console.log('\n[DONE]');
      continue;
    }

    const event = JSON.parse(payload);
    if (event.type === 'tool_call') {
      toolCalled = toolCalled || event.name === 'get_weather';
      console.log(`\n[tool_call] ${event.name}`);
    } else if (event.type === 'tool_result') {
      toolOutput = toolOutput || event.name === 'get_weather';
      console.log(`\n[tool_result] ${event.name}: ${event.content}`);
    } else if (event.type === 'ai_response') {
      answer += event.content;
      process.stdout.write(event.content);
    } else if (event.type === 'error_message') {
      console.log(`\n[error] ${event.content}`);
      process.exitCode = 1;
    }
  }
}

if (!toolCalled || !toolOutput || !answer.trim()) {
  console.log('\nTool smoke failed.');
  process.exitCode = 1;
}

function readDotEnv(path: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    entries[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return entries;
}
