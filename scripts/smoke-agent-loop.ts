import assert from 'node:assert/strict';
import { Agent, MemorySession, RunContext, setTracingDisabled } from '@openai/agents';
import { onRequest } from '../agents/chat/index';
import { createRimeTools } from '../agents/chat/_tools';
import { TURN_LIMIT_REPLY } from '../agents/chat/_run-policy';

// Use the actual Agents SDK and SSE handler. All model/KB traffic is replaced
// below, so this regression needs neither .env nor credentials nor a network.
setTracingDisabled(true);

const MODEL = '@makers/deepseek-v4-flash';
const MESSAGE = '我想使用自然码双拼，请告诉我如何在当前客户端中配置，并保留全拼方案。';
const SEARCH_QUERY = '自然码双拼 double_pinyin 保留全拼';
const ANSWER = '可以同时保留自然码双拼和全拼方案。请先确认你使用的 Rime 客户端，再按已有文档检查方案列表并重新部署。';
const env = {
  AI_GATEWAY_API_KEY: 'offline-test-key',
  AI_GATEWAY_BASE_URL: 'https://gateway.invalid/v1',
  AI_GATEWAY_MODEL: MODEL,
  CNB_KNOWLEDGE_BASE_TOKEN: 'offline-kb-token',
  CNB_KNOWLEDGE_BASE_URL: 'https://knowledge.invalid/query',
  ENABLE_MODEL_TOOLS: 'true',
};
const knowledgeFixture = [{
  title: 'oh-my-rime 自然码双拼与全拼配置',
  url: 'https://www.mintimate.cc/zh/guide/configuration.html',
  content: '使用自然码双拼 double_pinyin 时，可以在当前客户端的方案列表中保留全拼 rime_mint 方案。配置文件修改后需重新部署 Rime。',
  score: 0.95,
}];

type ChatMessage = {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
};
type ModelRequest = {
  model: string;
  stream?: boolean;
  messages: ChatMessage[];
  tools?: Array<{ function: { name: string } }>;
  tool_choice?: string;
  stream_options?: { include_usage?: boolean };
};
type Event = { type: string; name?: string; content?: string; [key: string]: unknown };

function completion(content: string) {
  return Response.json({
    id: 'offline-completion', object: 'chat.completion', created: 1, model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });
}

function streamedCompletion(turn: number, toolCall?: { name: string; args: Record<string, unknown> }) {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: `offline-turn-${turn}`, object: 'chat.completion.chunk', created: 1, model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const chunks = toolCall
    ? [
        chunk({ role: 'assistant', tool_calls: [{
          index: 0, id: `call-${turn}`, type: 'function',
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
        }] }),
        chunk({}, 'tool_calls'),
      ]
    : [chunk({ role: 'assistant', content: ANSWER }), chunk({}, 'stop')];
  // Distinct counts per turn detect accidentally reporting only the last call.
  chunks.push({ ...chunk({}), choices: [], usage: {
    prompt_tokens: 10 + turn, completion_tokens: turn, total_tokens: 10 + 2 * turn,
  } } as typeof chunks[number]);
  const text = chunks.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
}

function installFetchStub(ignoreFinalToolChoice = false) {
  const originalFetch = globalThis.fetch;
  const requests: ModelRequest[] = [];
  const knowledgeQueries: string[] = [];
  const counts = { judge: 0, planner: 0 };
  const violations: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (url === env.CNB_KNOWLEDGE_BASE_URL) {
      knowledgeQueries.push(body.query);
      // Yield once so concurrent duplicate tool calls must reuse the in-flight
      // Promise, not only a result cached after the first request completes.
      await Promise.resolve();
      return Response.json(knowledgeFixture);
    }
    if (url !== `${env.AI_GATEWAY_BASE_URL}/chat/completions`) {
      violations.push(`unexpected network request: ${url}`);
      throw new Error('offline test blocked an unexpected network request');
    }
    const request = body as ModelRequest;
    assert.equal(request.model, MODEL);
    if (!request.stream) {
      if (request.messages[0]?.content?.includes('strict classifier')) {
        counts.judge += 1;
        return completion(JSON.stringify({ off_topic: false }));
      }
      assert.match(request.messages[0]?.content ?? '', /documentation retrieval queries/);
      counts.planner += 1;
      return completion(JSON.stringify({ queries: ['自然码双拼与全拼方案列表'] }));
    }

    requests.push(request);
    const turn = requests.length;
    assert.equal(request.stream_options?.include_usage, true);
    const names = request.tools?.map((item) => item.function.name) ?? [];
    if (names.length === 0) {
      return streamedCompletion(turn, ignoreFinalToolChoice
        ? { name: 'resolve_client', args: { platform_text: '鼠须管 macOS' } }
        : undefined);
    }
    if (turn <= 2) {
      assert.ok(names.includes('search_docs'), `turn ${turn} should allow supplemental retrieval`);
      return streamedCompletion(turn, {
        name: 'search_docs',
        args: { query: turn === 1 ? SEARCH_QUERY : `  自然码双拼   double_pinyin\n保留全拼  ` },
      });
    }
    // An uncooperative model keeps asking for a tool even after having enough
    // evidence. The application must reserve one turn to produce an answer.
    assert.ok(names.includes('resolve_client'));
    return streamedCompletion(turn, { name: 'resolve_client', args: { platform_text: '鼠须管 macOS' } });
  };
  return { requests, knowledgeQueries, counts, violations, restore: () => { globalThis.fetch = originalFetch; } };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('offline agent-loop test timed out')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function parseEvents(text: string): Event[] {
  return text.split('\n\n').filter((frame) => frame.startsWith('data: {'))
    .map((frame) => JSON.parse(frame.slice(6)));
}

for (const ignoreFinalToolChoice of [false, true]) {
  const stub = installFetchStub(ignoreFinalToolChoice);
  const controller = new AbortController();
  const session = new MemorySession({ sessionId: `offline-agent-loop-${ignoreFinalToolChoice}` });
  const executedTools: string[] = [];
  const tracer = {
    async span<T>(name: string, execute: () => Promise<T>): Promise<T> {
      if (name.startsWith('tool:')) executedTools.push(name.slice(5));
      return execute();
    },
  };
  try {
    const response = await onRequest({
      conversation_id: 'offline-agent-loop',
      request: { body: { message: MESSAGE }, signal: controller.signal, headers: {} },
      env,
      tracer,
      tools: { all: () => [] },
      store: { openaiSession: () => session },
    });
    assert.equal(response.status, 200);
    const text = await within(response.text());
    const events = parseEvents(text);
    assert.deepEqual(stub.violations, []);
    assert.doesNotMatch(text, /Max turns|error_message/);
    assert.match(text, /\[DONE\]/);
    const expectedAnswer = ignoreFinalToolChoice ? TURN_LIMIT_REPLY : ANSWER;
    assert.equal(events.filter((event) => event.type === 'ai_response').map((event) => event.content).join(''), expectedAnswer);
    assert.deepEqual(stub.counts, { judge: 1, planner: 1 });

    assert.equal(stub.requests.length, 6, 'five tool turns must leave the sixth model call for an answer');
    for (const [index, request] of stub.requests.entries()) {
      const toolNames = request.tools?.map((item) => item.function.name) ?? [];
      assert.equal(toolNames.includes('search_docs'), index < 2, 'search_docs must disappear after two calls');
    }
    const finalRequest = stub.requests.at(-1)!;
    assert.equal(finalRequest.tools?.length ?? 0, 0, 'the final model turn must not offer tools');
    assert.equal(finalRequest.tool_choice, 'none', 'the final model turn must explicitly request text');
    const results = finalRequest.messages.filter((message) => message.role === 'tool');
    assert.equal(results.length, 5, 'final answer must retain every completed tool result');
    assert.match(String(results[0]?.content), /自然码双拼/);
    assert.match(String(results.at(-1)?.content), /squirrel/);
    assert.equal(events.filter((event) => event.type === 'tool_call' && event.name === 'search_docs').length, 2);
    assert.equal(events.filter((event) => event.type === 'tool_result' && event.name === 'search_docs').length, 2);
    assert.deepEqual(executedTools, ['search_docs', 'search_docs', 'resolve_client', 'resolve_client', 'resolve_client'],
      'the sixth model call cannot execute a tool, even if the provider ignores tool_choice');
    assert.equal(stub.knowledgeQueries.length, 3, 'two initial lookups plus one cached supplemental lookup');
    assert.equal(stub.knowledgeQueries.filter((query) => query.trim().replace(/\s+/g, ' ') === SEARCH_QUERY).length, 1);
    assert.deepEqual(events.filter((event) => event.type === 'usage'), [{
      type: 'usage', input_tokens: 81, output_tokens: 21, total_tokens: 102,
    }], 'usage must include all six Agent model calls');

    const history = await session.getItems();
    const userItems = history.filter((item) => 'role' in item && item.role === 'user');
    assert.equal(userItems.length, 1, 'the SDK session must save the user input only once');
    assert.match(JSON.stringify(userItems[0]), /自然码双拼/);
    const answerItems = history.filter((item) => 'role' in item && item.role === 'assistant'
      && JSON.stringify(item).includes(expectedAnswer));
    assert.equal(answerItems.length, 1, 'the final answer, including fallback, must be saved only once');
    const calls = history.filter((item) => item.type === 'function_call');
    const outputs = history.filter((item) => item.type === 'function_call_result');
    assert.equal(calls.length, ignoreFinalToolChoice ? 6 : 5);
    assert.equal(outputs.length, calls.length, 'session history must not contain unmatched function calls');
    assert.deepEqual(outputs.map((item) => item.callId).sort(), calls.map((item) => item.callId).sort());
    console.log(`Agent loop smoke passed: ${ignoreFinalToolChoice ? 'provider ignores tool limit; graceful fallback' : 'final reserved turn answers'}; context, session, and total usage survive`);
  } finally {
    controller.abort();
    stub.restore();
  }
}

{
  const stub = installFetchStub();
  try {
    const agent = new Agent({ name: 'Offline tool budget test' });
    const runContext = new RunContext();
    const first = createRimeTools({ env }).find((item) => item.name === 'search_docs')!;
    assert.equal(await first.isEnabled(runContext, agent), true);
    const [initial, duplicate] = await Promise.all([
      first.invoke(runContext, JSON.stringify({ query: SEARCH_QUERY })),
      first.invoke(runContext, JSON.stringify({ query: `  自然码双拼  double_pinyin\n保留全拼  ` })),
    ]);
    assert.match(String(initial), /自然码双拼/);
    assert.equal(duplicate, initial, 'concurrent equivalent queries should share their result');
    assert.equal(stub.knowledgeQueries.length, 1, 'concurrent duplicate calls share one in-flight KB request');
    assert.equal(await first.isEnabled(runContext, agent), false, 'search budget should be exhausted');

    const next = createRimeTools({ env }).find((item) => item.name === 'search_docs')!;
    assert.equal(await next.isEnabled(runContext, agent), true, 'a new request gets a fresh search budget');
    await next.invoke(runContext, JSON.stringify({ query: SEARCH_QUERY }));
    assert.equal(stub.knowledgeQueries.length, 2, 'a fresh request does not reuse the previous request cache');
    assert.equal(await next.isEnabled(runContext, agent), true, 'one search remains in the fresh request');
    assert.deepEqual(stub.violations, []);
    console.log('Agent loop smoke passed: concurrent search caching and independent request budgets');
  } finally {
    stub.restore();
  }
}
