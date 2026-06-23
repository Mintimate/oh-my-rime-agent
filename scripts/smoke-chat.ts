import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { onRequest } from '../agents/chat/index';

const env = readDotEnv('.env');
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 90_000);

const response = await onRequest({
  conversation_id: randomUUID(),
  request: {
    body: {
      message: '小狼毫如何设置横向候选栏？请给出 oh-my-rime 用户应该修改的配置文件和 YAML 示例。',
    },
    signal: controller.signal,
    headers: {},
  },
  env,
  tools: {
    all() {
      return [];
    },
  },
});

clearTimeout(timeout);

if (response.status !== 200 || !response.body) {
  console.log(`HTTP ${response.status}`);
  console.log(await response.text());
  process.exitCode = 1;
} else {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  const eventCounts = new Map<string, number>();

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
      eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);

      if (event.type === 'ai_response') {
        answer += event.content;
        process.stdout.write(event.content);
      } else if (event.type === 'tool_call') {
        console.log(`\n[tool_call] ${event.name}`);
      } else if (event.type === 'tool_result') {
        console.log(`\n[tool_result] ${event.name}: ${event.content}`);
      } else if (event.type === 'error_message') {
        console.log(`\n[error] ${event.content}`);
        process.exitCode = 1;
      }
    }
  }

  console.log('\n\n[event_counts]');
  for (const [type, count] of eventCounts) {
    console.log(`${type}: ${count}`);
  }

  if (!answer.trim()) {
    console.log('No assistant answer was streamed.');
    process.exitCode = 1;
  }
}

function readDotEnv(path: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    entries[key] = value.replace(/^"(.*)"$/, '$1');
  }
  return entries;
}
