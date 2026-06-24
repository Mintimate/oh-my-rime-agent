import { Agent, run, type Session } from '@openai/agents';
import { createGatewayClient, createGatewayModel, getAgentEnv, resolveGatewayModelName, type AgentEnv } from '../_model';
import { createLogger, createSSEResponse, jsonResponse, sseEvent, truncateText } from '../_shared';
import { buildSystemPrompt, buildUserInput } from './_prompt';
import { queryOhMyRimeKnowledgeBase } from './_knowledge';
import { diagnoseUploadedRimeDirectory } from './_uploads';
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
  const uploadedConfigFiles = Array.isArray(body.configFiles) ? body.configFiles : [];
  const hasUploadedConfigFiles = uploadedConfigFiles.length > 0;
  const effectiveMessage = message || (hasUploadedConfigFiles ? '请诊断上传的 Rime 配置文件。' : '');
  const signal = context.request?.signal as AbortSignal | undefined;
  const conversationId = context.conversation_id as string | undefined;
  const tracer = context.tracer;

  if (!effectiveMessage) {
    return jsonResponse({ error: "'message' is required unless configFiles are uploaded" }, 400);
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
                () => queryOhMyRimeKnowledgeBase(effectiveMessage, context.env ?? {}, signal),
                { 'kb.query': effectiveMessage.slice(0, 200) },
              )
            : queryOhMyRimeKnowledgeBase(effectiveMessage, context.env ?? {}, signal)
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

        let directoryDiagnosticContext = '';
        if (hasUploadedConfigFiles) {
          yield sseEvent({
            type: 'thinking',
            content: '检测到用户上传了 Rime 配置文件，先在沙盒中做文件级配置诊断。',
          });
          yield sseEvent({ type: 'tool_call', name: 'diagnose_rime_directory' });

          const diagnostic = await (
            tracer
              ? tracer.span(
                  'uploaded_rime_files_diagnostic',
                  () => diagnoseUploadedRimeDirectory(uploadedConfigFiles, context.sandbox, conversationId),
                  { 'upload.file_count': uploadedConfigFiles.length },
                )
              : diagnoseUploadedRimeDirectory(uploadedConfigFiles, context.sandbox, conversationId)
          );

          if (diagnostic) {
            directoryDiagnosticContext = diagnostic.summaryText;
            yield sseEvent({
              type: 'tool_result',
              name: 'diagnose_rime_directory',
              content: truncateText(diagnostic.summaryText, 1200),
            });
          } else {
            yield sseEvent({
              type: 'tool_result',
              name: 'diagnose_rime_directory',
              content: 'No supported Rime text config files were uploaded.',
            });
          }
        }

        const combinedExtraContext = [extraContext, directoryDiagnosticContext].filter(Boolean).join('\n\n');
        const userInput = buildUserInput(effectiveMessage, combinedExtraContext);
        const systemPrompt = buildSystemPrompt(knowledge, effectiveMessage);

        if (shouldEnableModelTools(context.env ?? {})) {
          yield sseEvent({
            type: 'thinking',
            content: '接下来让模型在 Rime 专用工具中选择需要调用的工具，例如确认客户端、目标文件或生成 patch。',
          });
          yield* runOpenAIToolChat(env, context.env ?? {}, systemPrompt, userInput, tracer, signal, context.sandbox);
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
  sandbox?: any,
) {
  const client = createGatewayClient(env);
  const model = resolveGatewayModelName(env);
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userInput },
  ];
  const tools = createRimeOpenAITools();
  const calledTools = new Set<string>();

  let accumInputTokens = 0;
  let accumOutputTokens = 0;

  for (let turn = 0; turn < 10; turn += 1) {
    if (signal?.aborted) return;

    yield sseEvent({
      type: 'thinking',
      content: turn === 0 ? '根据用户问题选择下一步工具。' : '根据已有工具结果判断是否还需要继续调用工具。',
    });

    const response = await createTracedChatCompletion(
      tracer,
      client,
      {
        model,
        messages,
        tools: tools as any,
        tool_choice: 'auto',
        parallel_tool_calls: true,
        max_tokens: 2048,
        chat_template_kwargs: { enable_thinking: false },
      },
      { model, phase: 'tool_selection', turn },
    );

    if (response.usage) {
      accumInputTokens += response.usage.prompt_tokens ?? 0;
      accumOutputTokens += response.usage.completion_tokens ?? 0;
      yield sseEvent({
        type: 'usage',
        input_tokens: accumInputTokens,
        output_tokens: accumOutputTokens,
        total_tokens: accumInputTokens + accumOutputTokens,
      });
    }

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
      yield* streamOpenAIFinalAnswer(
        client,
        model,
        messages,
        { input_tokens: accumInputTokens, output_tokens: accumOutputTokens },
        tracer,
        signal,
      );
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
          ? tracer.span(`tool:${name}`, () => executeRimeOpenAITool(name, args, { env: contextEnv, signal, sandbox }), { 'tool.name': name })
          : executeRimeOpenAITool(name, args, { env: contextEnv, signal, sandbox })
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
  const wantsValidation = /检测|检查|校验|验证|是否合法|报错|不生效|yaml|custom/.test(text);
  const wantsConfigEdit = /修改|设置|生成|如何|怎么|候选栏|候选词|皮肤|快捷键|横向|横排|水平/.test(text);

  const missing: string[] = [];
  if (!wantsConfigEdit) {
    if (wantsValidation && !calledTools.has('check_yaml')) missing.push('check_yaml');
    return missing;
  }

  if (!calledTools.has('target_file') && !calledTools.has('recipe')) missing.push('target_file');
  if (/yaml|patch|配置|设置|修改|横向|横排|水平/.test(text) && !calledTools.has('make_patch') && !calledTools.has('recipe')) {
    missing.push('make_patch');
  }
  if (wantsValidation && !calledTools.has('check_yaml')) {
    missing.push('check_yaml');
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

async function* streamOpenAIFinalAnswer(
  client: ReturnType<typeof createGatewayClient>,
  model: string,
  messages: any[],
  accumulatedUsage: { input_tokens: number; output_tokens: number },
  tracer: any,
  signal?: AbortSignal,
) {
  const finalMessages = messages.map((message, index) =>
    index === 0 && message.role === 'system'
      ? {
          ...message,
          content: `${message.content}\n\nFinal response instruction: answer the user concisely using the tool results above. Do not call tools in this final response.`,
        }
      : message,
  );

  const { stream, span } = await createTracedChatCompletionStream(
    tracer,
    client,
    {
      model,
      messages: finalMessages,
      stream: true,
      max_tokens: 2048,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: false },
    },
    { model, phase: 'final_answer' },
  );

  let finalInput = accumulatedUsage.input_tokens;
  let finalOutput = accumulatedUsage.output_tokens;
  let hasChunkUsage = false;

  try {
    for await (const chunk of stream as any) {
      if (signal?.aborted) return;

      const delta = chunk.choices?.[0]?.delta;
      if (typeof delta?.content === 'string' && delta.content) {
        yield sseEvent({ type: 'ai_response', content: delta.content });
      }

      const chunkUsage = chunk.usage;
      if (chunkUsage) {
        hasChunkUsage = true;
        finalInput = accumulatedUsage.input_tokens + (chunkUsage.prompt_tokens ?? 0);
        finalOutput = accumulatedUsage.output_tokens + (chunkUsage.completion_tokens ?? 0);
        yield sseEvent({
          type: 'usage',
          input_tokens: finalInput,
          output_tokens: finalOutput,
          total_tokens: finalInput + finalOutput,
        });
      }
    }
  } finally {
    setLlmUsageAttributes(span, model, {
      prompt_tokens: Math.max(0, finalInput - accumulatedUsage.input_tokens),
      completion_tokens: Math.max(0, finalOutput - accumulatedUsage.output_tokens),
      total_tokens: Math.max(0, finalInput + finalOutput - accumulatedUsage.input_tokens - accumulatedUsage.output_tokens),
    });
    span?.end();
  }

  if (!hasChunkUsage) {
    yield sseEvent({
      type: 'usage',
      input_tokens: finalInput,
      output_tokens: finalOutput,
      total_tokens: finalInput + finalOutput,
    });
  }
}

async function createTracedChatCompletion(
  tracer: any,
  client: ReturnType<typeof createGatewayClient>,
  request: Record<string, unknown>,
  meta: { model: string; phase: string; turn?: number },
) {
  const run = async (span?: any) => {
    const response = await client.chat.completions.create(request as any);
    setLlmUsageAttributes(span, meta.model, response.usage);
    return response;
  };

  if (!tracer) return run();

  return tracer.span('openai_chat_completion', run, {
    ...buildLlmRequestAttributes(meta.model, meta.phase),
    ...(typeof meta.turn === 'number' ? { 'agent.turn': meta.turn } : {}),
  });
}

async function createTracedChatCompletionStream(
  tracer: any,
  client: ReturnType<typeof createGatewayClient>,
  request: Record<string, unknown>,
  meta: { model: string; phase: string },
) {
  const span = tracer?.startSpan?.('openai_chat_completion_stream', buildLlmRequestAttributes(meta.model, meta.phase));
  try {
    const stream = await client.chat.completions.create(request as any);
    return { stream, span };
  } catch (error) {
    span?.end();
    throw error;
  }
}

function buildLlmRequestAttributes(model: string, phase: string): Record<string, string | number | boolean> {
  return {
    'openinference.span.kind': 'LLM',
    'llm.system': 'openai',
    'llm.request.type': 'chat',
    'llm.model_name': model,
    'gen_ai.system': 'openai',
    'gen_ai.operation.name': 'chat',
    'gen_ai.request.model': model,
    'agent.llm_phase': phase,
  };
}

function setLlmUsageAttributes(
  span: any,
  model: string,
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null,
) {
  if (!span || !usage) return;

  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;

  try {
    span.setAttributes({
      'llm.model_name': model,
      'llm.token_count.prompt': inputTokens,
      'llm.token_count.completion': outputTokens,
      'llm.token_count.total': totalTokens,
      'gen_ai.response.model': model,
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.total_tokens': totalTokens,
    });
  } catch {
    // Tracing should never interrupt the user-facing stream.
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
