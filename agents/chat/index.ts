import { Agent, run, type Session } from '@openai/agents';
import { createGatewayClient, createGatewayModel, getAgentEnv, resolveGatewayModelName, type AgentEnv } from '../_model';
import { createLogger, createSSEResponse, jsonResponse, sseEvent, truncateText } from '../_shared';
import { buildSystemPrompt, buildUserInput } from './_prompt';
import { queryOhMyRimeKnowledgeBase } from './_knowledge';
import {
  createRimeOpenAITools,
  executeRimeOpenAITool,
  shouldEnableModelTools,
} from './_tools';

const logger = createLogger('chat');

export async function onRequest(context: any) {
  const body = context.request?.body ?? {};
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const extraContext = typeof body.context === 'string' ? body.context : undefined;
  const signal = context.request?.signal as AbortSignal | undefined;
  const conversationId = context.conversation_id as string | undefined;
  const tracer = context.tracer;

  if (!message) {
    return jsonResponse({ error: "'message' is required" }, 400);
  }

  if (!conversationId) {
    return jsonResponse({ error: "Missing required 'makers-conversation-id' header" }, 400);
  }

  // 为当前请求根 span 打上会话标签，让控制台的跨 run 聚合功能正常工作
  tracer?.setAttributes({
    'agent.conversation_id': conversationId,
    'agent.route_path': '/chat',
  });

  return createSSEResponse(
    async function* () {
      try {
        const env = getAgentEnv(context.env);
        yield sseEvent({
          type: 'thinking',
          content: '先检索 oh-my-rime 文档，确认这个问题对应的官方配置项和平台差异。',
        });
        yield sseEvent({ type: 'tool_call', name: 'oh_my_rime_knowledge_base' });

        // queryOhMyRimeKnowledgeBase 是原始 fetch，平台无法自动插桩，需手动包裹 span
        const knowledge = await (
          tracer
            ? tracer.span(
                'knowledge_base_query',
                () => queryOhMyRimeKnowledgeBase(message, context.env ?? {}, signal),
                { 'kb.query': message.slice(0, 200) },
              )
            : queryOhMyRimeKnowledgeBase(message, context.env ?? {}, signal)
        );
        if (knowledge.warning) {
          yield sseEvent({
            type: 'tool_result',
            name: 'oh_my_rime_knowledge_base',
            content: knowledge.warning,
          });
        } else {
          yield sseEvent({
            type: 'tool_result',
            name: 'oh_my_rime_knowledge_base',
            content: `${knowledge.hits.length} relevant document chunk(s) found.`,
          });
        }

        if (signal?.aborted) return;

        const userInput = buildUserInput(message, extraContext);
        const systemPrompt = buildSystemPrompt(knowledge, message);

        if (shouldEnableModelTools(context.env ?? {})) {
          yield sseEvent({
            type: 'thinking',
            content: '接下来让模型在 Rime 专用工具中选择需要调用的工具，例如确认客户端、目标文件或生成 patch。',
          });
          yield* runOpenAIToolChat(env, context.env ?? {}, systemPrompt, userInput, tracer, signal);
          return;
        }

        const agent = new Agent({
          name: 'Oh My Rime Agent',
          instructions: systemPrompt,
          model: createGatewayModel(env),
          modelSettings: {
            parallelToolCalls: false,
            providerData: {
              chat_template_kwargs: { enable_thinking: false },
            },
          },
          tools: [],
        });

        const session: Session | undefined =
          context.store && conversationId ? context.store.openaiSession(conversationId) : undefined;

        const result = await run(agent, userInput, {
          stream: true,
          signal,
          session,
          maxTurns: 6,
        });

        let usage: Usage | null = null;
        for await (const event of result.toStream()) {
          if (signal?.aborted) break;
          const mapped = toSseEvent(event);
          if (mapped) {
            yield sseEvent(mapped);
          }

          usage = extractUsage(event) ?? usage;
        }

        usage = extractUsage(result) ?? usage;
        if (usage) {
          yield sseEvent({ type: 'usage', ...usage });
        }
      } catch (error) {
        const err = error as Error;
        if (err.name === 'AbortError' || signal?.aborted || err.message?.includes('terminated')) return;
        logger.error(err);
        yield sseEvent({ type: 'error_message', content: err.message });
      }
    },
    signal,
  );
}

async function* runOpenAIToolChat(
  env: AgentEnv,
  contextEnv: Record<string, string | undefined>,
  systemPrompt: string,
  userInput: string,
  tracer: any,
  signal?: AbortSignal,
) {
  const client = createGatewayClient(env);
  const model = resolveGatewayModelName(env);
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userInput },
  ];
  const tools = createRimeOpenAITools();
  const calledTools = new Set<string>();

  for (let turn = 0; turn < 5; turn += 1) {
    if (signal?.aborted) return;

    yield sseEvent({
      type: 'thinking',
      content: turn === 0 ? '根据用户问题选择下一步工具。' : '根据已有工具结果判断是否还需要继续调用工具。',
    });

    const response = await client.chat.completions.create({
      model,
      messages,
      tools: tools as any,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      max_tokens: 2048,
      chat_template_kwargs: { enable_thinking: false },
    } as any);

    const choice = response.choices[0];
    const message = choice?.message as any;
    if (!message) {
      yield sseEvent({ type: 'error_message', content: 'Model returned no message.' });
      return;
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) {
      const missing = findMissingRequiredTools(userInput, calledTools);
      if (missing.length > 0) {
        yield sseEvent({
          type: 'thinking',
          content: `自审发现还缺少关键工具结果：${missing.join('、')}，继续补齐后再回答。`,
        });
        messages.push({ role: 'assistant', content: message.content ?? '' });
        messages.push({
          role: 'user',
          content: `自审：当前任务是配置编辑，请继续调用这些工具补齐依据后再最终回答：${missing.join(', ')}。`,
        });
        continue;
      }

      yield sseEvent({
        type: 'thinking',
        content: '工具信息已经足够，开始组织最终答案并流式输出。',
      });
      yield* streamOpenAIFinalAnswer(client, model, messages, signal);
      return;
    }

    messages.push({
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const name = call.function?.name ?? 'unknown';
      calledTools.add(name);
      yield sseEvent({ type: 'thinking', content: describeToolIntent(name) });
      yield sseEvent({ type: 'tool_call', name });

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        args = {};
      }

      const output = await (
        tracer
          ? tracer.span(`tool:${name}`, () => executeRimeOpenAITool(name, args, { env: contextEnv, signal }), { 'tool.name': name })
          : executeRimeOpenAITool(name, args, { env: contextEnv, signal })
      );
      yield sseEvent({ type: 'tool_result', name, content: truncateText(output, 500) });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: output,
      });
    }
  }

  yield sseEvent({ type: 'error_message', content: 'Tool loop exceeded maximum turns.' });
}

function findMissingRequiredTools(userInput: string, calledTools: Set<string>): string[] {
  const text = userInput.toLowerCase();
  const wantsConfigEdit = /配置|修改|设置|yaml|patch|候选栏|候选词|皮肤|快捷键|横向|横排|水平/.test(text);
  if (!wantsConfigEdit) return [];

  const missing: string[] = [];
  if (!calledTools.has('target_file') && !calledTools.has('recipe')) missing.push('target_file');
  if (/yaml|patch|配置|设置|修改|横向|横排|水平/.test(text) && !calledTools.has('make_patch') && !calledTools.has('recipe')) {
    missing.push('make_patch');
  }
  return missing;
}

function describeToolIntent(name: string): string {
  switch (name) {
    case 'search_docs':
      return '需要补充文档依据，调用文档检索工具。';
    case 'resolve_client':
      return '需要先确认用户所说的平台对应哪个 Rime 客户端。';
    case 'target_file':
      return '需要确认最安全的目标配置文件，避免误改基础 YAML。';
    case 'make_patch':
      return '已经有目标文件和配置路径，开始生成可直接使用的 YAML patch。';
    case 'check_yaml':
      return '用户给出了 YAML 或需要校验配置，开始检查常见 YAML/patch 问题。';
    case 'recipe':
      return '这是常见 oh-my-rime 配方问题，优先调用内置配方。';
    default:
      return `模型决定调用工具 ${name}。`;
  }
}

async function* streamOpenAIFinalAnswer(client: ReturnType<typeof createGatewayClient>, model: string, messages: any[], signal?: AbortSignal) {
  const finalMessages = messages.map((message, index) =>
    index === 0 && message.role === 'system'
      ? {
          ...message,
          content: `${message.content}\n\nFinal response instruction: answer the user concisely using the tool results above. Do not call tools in this final response.`,
        }
      : message,
  );

  const stream = await client.chat.completions.create({
    model,
    messages: finalMessages,
    stream: true,
    max_tokens: 2048,
    stream_options: { include_usage: true },
    chat_template_kwargs: { enable_thinking: false },
  } as any);

  let usage: Usage | null = null;
  for await (const chunk of stream as any) {
    if (signal?.aborted) return;

    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.content === 'string' && delta.content) {
      yield sseEvent({ type: 'ai_response', content: delta.content });
    }

    const chunkUsage = chunk.usage;
    if (chunkUsage) {
      usage = {
        input_tokens: chunkUsage.prompt_tokens,
        output_tokens: chunkUsage.completion_tokens,
        total_tokens: chunkUsage.total_tokens,
      };
    }
  }

  if (usage) {
    yield sseEvent({ type: 'usage', ...usage });
  }
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

function toSseEvent(event: unknown): Record<string, unknown> | null {
  const e = event as any;

  if (e.type === 'raw_model_stream_event' && e.data?.type === 'output_text_delta') {
    return { type: 'ai_response', content: e.data.delta as string };
  }

  if (e.type === 'run_item_stream_event' && e.name === 'tool_called') {
    const toolName = e.item?.name ?? e.item?.rawItem?.name;
    if (toolName) return { type: 'tool_call', name: toolName };
  }

  if (e.type === 'run_item_stream_event' && e.name === 'tool_output') {
    const name = e.item?.name ?? e.item?.rawItem?.name ?? 'tool';
    const output = e.item?.output ?? e.item?.rawItem?.output;
    return { type: 'tool_result', name, content: truncateText(output, 500) };
  }

  if (e.type === 'agent_updated_stream_event') {
    return { type: 'tool_call', name: `handoff:${e.agent?.name ?? 'agent'}` };
  }

  return null;
}

function extractUsage(value: unknown): Usage | null {
  const v = value as any;
  const usage = v?.usage ?? v?.data?.usage ?? v?.item?.rawItem?.usage;
  if (!usage) return null;

  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens;
  const totalTokens = usage.total_tokens ?? usage.totalTokens;

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return null;
  }

  return {
    input_tokens: typeof inputTokens === 'number' ? inputTokens : undefined,
    output_tokens: typeof outputTokens === 'number' ? outputTokens : undefined,
    total_tokens: typeof totalTokens === 'number' ? totalTokens : undefined,
  };
}
