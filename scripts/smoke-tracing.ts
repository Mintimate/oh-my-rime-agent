import assert from 'node:assert/strict';
import { RunContext, setTracingDisabled } from '@openai/agents';
import { onRequest } from '../agents/chat/index';
import { createRimeTools } from '../agents/chat/_tools';

// Exercise the real Agents SDK and request handler without credentials or network.
// The Makers tracer below is independent of the SDK's OpenAI trace exporter.
setTracingDisabled(true);

const MODEL = 'offline-tracing-model';
const FIRST_DELTA = '这是一段测试回答';
const env = {
  AI_GATEWAY_API_KEY: 'offline-test-key',
  AI_GATEWAY_BASE_URL: 'https://gateway.invalid/v1',
  AI_GATEWAY_MODEL: MODEL,
  CNB_KNOWLEDGE_BASE_TOKEN: 'offline-kb-token',
  CNB_KNOWLEDGE_BASE_URL: 'https://knowledge.invalid/query',
};

class RecordedSpan {
  attributes: Record<string, unknown>;
  endCount = 0;

  constructor(readonly name: string, attributes: Record<string, unknown>) {
    this.attributes = { ...attributes };
  }

  setAttributes(attributes: Record<string, unknown>) {
    assert.equal(this.endCount, 0, `${this.name}: attributes must be written before end()`);
    Object.assign(this.attributes, attributes);
  }

  end() {
    this.endCount += 1;
  }
}

class RecordedTracer {
  attributes: Record<string, unknown> = {};
  spans: RecordedSpan[] = [];

  setAttributes(attributes: Record<string, unknown>) {
    Object.assign(this.attributes, attributes);
  }

  startSpan(name: string, attributes: Record<string, unknown> = {}) {
    const span = new RecordedSpan(name, attributes);
    this.spans.push(span);
    return span;
  }

  async span<T>(name: string, run: (span: RecordedSpan) => Promise<T>, attributes = {}) {
    const span = this.startSpan(name, attributes);
    try {
      return await run(span);
    } finally {
      span.end();
    }
  }

  only(name: string) {
    const spans = this.spans.filter((span) => span.name === name);
    assert.equal(spans.length, 1, `expected one ${name} span`);
    return spans[0]!;
  }

  assertClosed() {
    for (const span of this.spans) {
      assert.equal(span.endCount, 1, `${span.name}: span should end exactly once`);
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('offline tracing test timed out')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function completion(content: string, promptTokens: number, completionTokens: number) {
  return Response.json({
    id: 'offline-completion', object: 'chat.completion', created: 1, model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

function installFetchStub(offTopic: boolean) {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let removeAbortListener: (() => void) | undefined;
  let streamClosed = false;
  const counts = { judge: 0, planner: 0, final: 0, knowledge: 0 };

  const send = (data: unknown) => {
    assert.ok(streamController, 'model stream should have started');
    streamController.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: 'offline-stream', object: 'chat.completion.chunk', created: 1, model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const fail = (error: Error) => {
    if (streamClosed) return;
    streamClosed = true;
    removeAbortListener?.();
    streamController?.error(error);
  };

  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === env.CNB_KNOWLEDGE_BASE_URL) {
      counts.knowledge += 1;
      return Response.json([]);
    }
    assert.equal(url, `${env.AI_GATEWAY_BASE_URL}/chat/completions`, 'unexpected network request');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, MODEL);
    if (!body.stream) {
      if (body.messages[0]?.content.includes('strict classifier')) {
        counts.judge += 1;
        return completion(JSON.stringify({ off_topic: offTopic }), 3, 1);
      }
      assert.match(body.messages[0]?.content, /documentation retrieval queries/);
      counts.planner += 1;
      return completion(JSON.stringify({ queries: ['Rime 文档检索'] }), 5, 2);
    }

    counts.final += 1;
    assert.equal(counts.final, 1, 'final answer should use one model request');
    const signal = init?.signal;
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        const abort = () => fail(new DOMException('offline request aborted', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        removeAbortListener = () => signal?.removeEventListener('abort', abort);
        if (signal?.aborted) {
          abort();
          return;
        }
        send(chunk({ role: 'assistant', content: FIRST_DELTA }));
        // Deliberately leave the stream open until the test finishes or aborts it.
      },
      cancel() {
        streamClosed = true;
        removeAbortListener?.();
      },
    });
    return new Response(bodyStream, { headers: { 'Content-Type': 'text/event-stream' } });
  };

  return {
    counts,
    fail,
    finish() {
      send(chunk({}, 'stop'));
      send({ ...chunk({}), choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
      streamController!.enqueue(encoder.encode('data: [DONE]\n\n'));
      streamController!.close();
      streamClosed = true;
      removeAbortListener?.();
    },
    restore() {
      fail(new Error('offline test cleanup'));
      globalThis.fetch = originalFetch;
    },
  };
}

async function startChat(tracer: RecordedTracer | undefined, controller: AbortController) {
  return onRequest({
    conversation_id: 'offline-tracing-conversation',
    request: { body: { message: 'Rime 测试问题' }, signal: controller.signal, headers: {} },
    env,
    tracer,
    tools: { all: () => [] },
  });
}

function readChat(response: Response) {
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const firstDelta = deferred<void>();
  const done = (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (text.includes(FIRST_DELTA)) firstDelta.resolve();
    }
    return text;
  })();
  return { firstDelta: firstDelta.promise, done };
}

function assertLlmSpan(span: RecordedSpan, prompt: number, completion: number) {
  assert.equal(span.attributes['openinference.span.kind'], 'LLM');
  assert.equal(span.attributes['llm.model_name'], MODEL);
  assert.equal(span.attributes['llm.token_count.prompt'], prompt);
  assert.equal(span.attributes['llm.token_count.completion'], completion);
  assert.equal(span.attributes['llm.token_count.total'], prompt + completion);
  assert.ok(span.attributes['input.value'], `${span.name}: missing input`);
  assert.ok(span.attributes['output.value'], `${span.name}: missing output`);
}

for (const outcome of ['success', 'error', 'abort', 'no-tracer'] as const) {
  const stub = installFetchStub(true);
  const tracer = outcome === 'no-tracer' ? undefined : new RecordedTracer();
  const controller = new AbortController();
  try {
    const chat = readChat(await startChat(tracer, controller));
    await within(chat.firstDelta);
    const span = tracer?.only('openai_agents_run');
    if (span) {
      assert.equal(span.endCount, 0, 'final span must stay open while model output is streaming');
      assert.equal(span.attributes['openinference.span.kind'], 'AGENT');
    }

    if (outcome === 'error') stub.fail(new Error('synthetic streaming failure'));
    else if (outcome === 'abort') controller.abort();
    else stub.finish();

    const text = await within(chat.done);
    tracer?.assertClosed();
    if (tracer) assertLlmSpan(tracer.only('judge_off_topic'), 3, 1);
    assert.deepEqual(stub.counts, { judge: 1, planner: 0, final: 1, knowledge: 0 });
    if (span) {
      assert.ok(Number(span.attributes['agent.stream_event_count']) > 0);
      assert.equal(span.attributes['agent.aborted'], outcome === 'abort');
    }
    if (outcome === 'error') {
      assert.equal(span!.attributes.error, true);
      assert.match(String(span!.attributes['error.message']), /synthetic streaming failure/);
      assert.ok(span!.attributes['error.type']);
      assert.match(text, /error_message/);
    } else if (outcome === 'abort') {
      assert.doesNotMatch(text, /error_message|\[DONE\]/);
    } else {
      assert.match(text, /\[DONE\]/);
      assert.doesNotMatch(text, /error_message/);
      const events = text.split('\n\n').filter((frame) => frame.startsWith('data: {'))
        .map((frame) => JSON.parse(frame.slice(6)));
      const usage = events.find((event) => event.type === 'usage');
      assert.deepEqual(usage, { type: 'usage', input_tokens: 11, output_tokens: 7, total_tokens: 18 });
      if (span) {
        assert.equal(span.attributes['agent.usage.input_tokens'], 11);
        assert.equal(span.attributes['agent.usage.output_tokens'], 7);
        assert.equal(span.attributes['agent.usage.total_tokens'], 18);
      }
    }
    console.log(`Tracing smoke passed: ${outcome}`);
  } finally {
    controller.abort();
    stub.restore();
  }
}

// The on-topic/irrelevant-KB branch exercises direct LLM and RETRIEVER spans
// without needing a second final-answer model stream.
{
  const stub = installFetchStub(false);
  const tracer = new RecordedTracer();
  const controller = new AbortController();
  try {
    const text = await within((await startChat(tracer, controller)).text());
    assertLlmSpan(tracer.only('judge_off_topic'), 3, 1);
    assertLlmSpan(tracer.only('plan_knowledge_queries'), 5, 2);
    const knowledgeSpans = tracer.spans.filter((span) => span.name === 'knowledge_base_query');
    assert.equal(knowledgeSpans.length, 2);
    for (const span of knowledgeSpans) assert.equal(span.attributes['openinference.span.kind'], 'RETRIEVER');
    assert.deepEqual(stub.counts, { judge: 1, planner: 1, final: 0, knowledge: 2 });
    assert.equal(tracer.attributes['agent.conversation_id'], 'offline-tracing-conversation');
    assert.match(text, /ai_response/);
    assert.doesNotMatch(text, /error_message/);
    tracer.assertClosed();
    console.log('Tracing smoke passed: direct LLM usage and knowledge RETRIEVER spans');
  } finally {
    controller.abort();
    stub.restore();
  }
}

{
  const tracer = new RecordedTracer();
  const makePatch = createRimeTools({ env: {}, tracer }).find((tool) => tool.name === 'make_patch');
  assert.ok(makePatch);
  const result = await makePatch.invoke(new RunContext(), JSON.stringify({
    entries: [{ path: 'menu/page_size', value: 6 }],
  }));
  assert.match(String(result), /"menu\/page_size": 6/);
  assert.equal(tracer.only('tool:make_patch').attributes['openinference.span.kind'], 'TOOL');
  tracer.assertClosed();
  console.log('Tracing smoke passed: Rime TOOL span');
}
