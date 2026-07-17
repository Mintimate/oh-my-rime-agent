import { Agent, run, type AgentInputItem, type Session } from '@openai/agents';
import { createGatewayClient, createGatewayModel, getAgentEnv, resolveGatewayModelName, type AgentEnv } from '../_model';
import { createLogger, createSSEResponse, jsonResponse, sseEvent, createToolCallXmlStreamFilter, truncateText } from '../_shared';
import { buildSystemPrompt, buildUserInput } from './_prompt';
import {
  buildUnsupportedKnowledgeResponse,
  formatKnowledgeContext,
  mergeKnowledgeResults,
  queryOhMyRimeKnowledgeBase,
  type KnowledgeHit,
  type KnowledgeResult,
} from './_knowledge';
import { diagnoseUploadedRimeDirectory } from './_uploads';
import {
  createRimeOpenAITools,
  executeRimeOpenAITool,
  shouldEnableModelTools,
} from './_tools';

const logger = createLogger('chat');
const MAX_OBSERVED_KB_HITS = 5;
const KB_TRACE_PREVIEW_CHARS = 240;
const MAX_PASTED_IMAGES = 3;
const MAX_PASTED_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PASTED_IMAGE_TOTAL_BYTES = MAX_PASTED_IMAGES * MAX_PASTED_IMAGE_BYTES;
const MAX_PASTED_IMAGE_DATA_URL_CHARS = Math.ceil((MAX_PASTED_IMAGE_BYTES * 4) / 3) + 128;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_EXTRA_CONTEXT_CHARS = 16_000;
const MAX_MODEL_TOOL_TURNS = 6;
const MAX_KNOWLEDGE_QUERIES = 3;

interface PastedImageInput {
  name?: unknown;
  type?: unknown;
  size?: unknown;
  dataUrl?: unknown;
}

interface PastedImage {
  name: string;
  type: string;
  size: number;
  dataUrl: string;
}

export async function onRequest(context: any) {
  const body = context.request?.body ?? {};
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const extraContext = typeof body.context === 'string' ? body.context : undefined;
  const uploadedConfigFiles = Array.isArray(body.configFiles) ? body.configFiles : [];
  const pastedImages = normalizePastedImages(body.pastedImages);
  const hasUploadedConfigFiles = uploadedConfigFiles.length > 0;
  const hasPastedImages = pastedImages.length > 0;
  const effectiveMessage = message || (hasUploadedConfigFiles ? '请诊断上传的 Rime 配置文件。' : hasPastedImages ? '请根据粘贴的截图诊断 Rime 配置问题。' : '');
  const signal = context.request?.signal as AbortSignal | undefined;
  const conversationId = context.conversation_id as string | undefined;
  const tracer = context.tracer;

  if (!effectiveMessage) {
    return jsonResponse({ error: "'message' is required unless configFiles are uploaded" }, 400);
  }

  if (message.length > MAX_MESSAGE_CHARS || (extraContext?.length ?? 0) > MAX_EXTRA_CONTEXT_CHARS) {
    return jsonResponse({ error: 'Message or extra context exceeds the request limit.' }, 413);
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
        const client = createGatewayClient(env);
        const model = resolveGatewayModelName(env);

        // 1. 判断是否偏离主题或属于非 RIME 相关的通用程序编写请求
        // 意图识别交给模型判断，不用关键词正则短路——正则容易把恰好命中中文关键词
        // （如"配置""修改"）但实际无关的问题误判为"明显 Rime 话题"，绕过安全边界判断。
        yield sseEvent({
          type: 'thinking',
          content: '正在进行需求自审，判断是否属于 Rime 相关内容咨询或配置编写。',
        });

        yield sseEvent({ type: 'tool_call', name: 'judge_off_topic' });
        const isOffTopic = await judgeOffTopicWithTelemetry(effectiveMessage, env, tracer);
        yield sseEvent({
          type: 'tool_result',
          name: 'judge_off_topic',
          content: isOffTopic ? '自审未通过：问题不属于 Rime / oh-my-rime 范围。' : '自审通过：问题属于 Rime / oh-my-rime 范围。',
        });

        tracer?.setAttributes(
          buildContextCompositionAttributes({ knowledge: { available: false, hits: [] }, extraContext, hasUploadedConfigFiles }),
        );

        if (signal?.aborted) return;

        if (isOffTopic) {
          yield sseEvent({
            type: 'thinking',
            content: '检测到该咨询偏离了 Rime 输入法配置主题，或属于非 Rime 相关的通用编程请求，准备进行安全边界答复。',
          });
          const systemPrompt = buildSystemPrompt({ available: false, hits: [] }, effectiveMessage);
          const userInput = buildUserInput(effectiveMessage);
          
          yield* streamOpenAIFinalAnswer(
            client,
            model,
            [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: buildOpenAIUserContent(userInput, pastedImages) },
            ],
            { input_tokens: 0, output_tokens: 0 },
            tracer,
            signal,
          );
          return;
        }

        // 2. 在确认属于 RIME 相关内容后，才执行知识库检索
        // 先完整走完检索查询规划，再开始知识库检索，避免父子工具的事件时序穿插。
        yield sseEvent({
          type: 'thinking',
          content: '先规划 oh-my-rime 文档检索查询，确认这个问题对应的官方配置项和平台差异。',
        });

        yield sseEvent({ type: 'tool_call', name: 'plan_knowledge_queries' });
        const knowledgeQueries = await planKnowledgeQueries(effectiveMessage, env, signal, tracer);
        yield sseEvent({
          type: 'tool_result',
          name: 'plan_knowledge_queries',
          content: `已生成 ${knowledgeQueries.length} 条检索查询，并保留原始问题作为兜底。`,
        });

        yield sseEvent({ type: 'tool_call', name: 'oh_my_rime_knowledge_base' });
        const knowledgeResults = await Promise.all(
          knowledgeQueries.map((query, index) =>
            queryKnowledgeWithTelemetry(query, context.env ?? {}, signal, tracer, {
              source: `pre_answer:${index + 1}`,
              conversationId,
            }),
          ),
        );
        const knowledge = mergeKnowledgeResults(knowledgeResults, knowledgeQueries);
        yield sseEvent({
          type: 'tool_result',
          name: 'oh_my_rime_knowledge_base',
          content: formatKnowledgeUserSummary(knowledge),
        });

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

        const pastedImageContext = formatPastedImageContext(pastedImages);
        const combinedExtraContext = [extraContext, directoryDiagnosticContext, pastedImageContext].filter(Boolean).join('\n\n');

        if (!knowledge.relevant && !directoryDiagnosticContext) {
          tracer?.setAttributes(
            buildContextCompositionAttributes({ knowledge, extraContext: combinedExtraContext, hasUploadedConfigFiles }),
          );
          yield sseEvent({
            type: 'thinking',
            content: '知识库没有提供与问题匹配的证据。为避免臆测配置，停止生成配置方案。',
          });
          yield sseEvent({ type: 'ai_response', content: buildUnsupportedKnowledgeResponse(knowledge) });
          return;
        }

        const userInput = buildUserInput(effectiveMessage, combinedExtraContext);
        const systemPrompt = buildSystemPrompt(knowledge, effectiveMessage);
        yield sseEvent({ type: 'tool_call', name: 'compose_prompt_context' });
        const contextAttributes = buildContextCompositionAttributes({
          knowledge,
          extraContext: combinedExtraContext,
          hasUploadedConfigFiles,
        });
        tracer?.setAttributes(contextAttributes);
        yield sseEvent({
          type: 'tool_result',
          name: 'compose_prompt_context',
          content: `已构建回答上下文：知识库 ${knowledge.hits.length} 条，额外上下文 ${combinedExtraContext ? '已合并' : '无'}。`,
        });

        if (shouldEnableModelTools(context.env ?? {}) && knowledge.relevant) {
          yield sseEvent({
            type: 'thinking',
            content: '接下来让模型在 Rime 专用工具中选择需要调用的工具，例如确认客户端、目标文件或生成 patch。',
          });
          yield* runOpenAIToolChat(env, context.env ?? {}, systemPrompt, userInput, pastedImages, tracer, signal, context.sandbox);
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
          tools: getDocumentationBrowserTools(context, knowledge),
        });

        const session: Session | undefined =
          context.store && conversationId ? context.store.openaiSession(conversationId) : undefined;

        const result = await run(agent, buildAgentUserInput(userInput, pastedImages), {
          stream: true,
          signal,
          session,
          maxTurns: 6,
        });

        let usage: Usage | null = null;
        const xmlFilter = createToolCallXmlStreamFilter();
        for await (const event of result.toStream()) {
          if (signal?.aborted) break;
          const mapped = toSseEvent(event);
          if (mapped) {
            if (mapped.type === 'ai_response') {
              for (const piece of xmlFilter.push(mapped.content as string)) {
                yield sseEvent({ ...mapped, content: piece });
              }
            } else {
              yield sseEvent(mapped);
            }
          }

          usage = extractUsage(event) ?? usage;
        }
        for (const piece of xmlFilter.flush()) {
          yield sseEvent({ type: 'ai_response', content: piece });
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

export function normalizePastedImages(rawImages: unknown): PastedImage[] {
  if (!Array.isArray(rawImages)) return [];

  const images: PastedImage[] = [];
  let totalBytes = 0;
  for (const raw of rawImages.slice(0, MAX_PASTED_IMAGES)) {
    if (!isRecord(raw)) continue;
    const item = raw as PastedImageInput;
    const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
    const dataUrl = typeof item.dataUrl === 'string' ? item.dataUrl : '';
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(type)) continue;
    if (!dataUrl.startsWith(`data:${type};base64,`)) continue;
    if (dataUrl.length > MAX_PASTED_IMAGE_DATA_URL_CHARS) continue;

    const size = estimateDataUrlBytes(dataUrl, type);
    if (size === null || size <= 0 || size > MAX_PASTED_IMAGE_BYTES) continue;
    if (totalBytes + size > MAX_PASTED_IMAGE_TOTAL_BYTES) continue;

    images.push({
      name: sanitizeImageName(typeof item.name === 'string' ? item.name : `pasted-image-${images.length + 1}`),
      type,
      size,
      dataUrl,
    });
    totalBytes += size;
  }

  return images;
}

function buildOpenAIUserContent(text: string, images: PastedImage[]) {
  if (images.length === 0) return text;

  return [
    { type: 'text', text },
    ...images.map((image) => ({
      type: 'image_url',
      image_url: {
        url: image.dataUrl,
        detail: 'high',
      },
    })),
  ];
}

function buildAgentUserInput(text: string, images: PastedImage[]): string | AgentInputItem[] {
  if (images.length === 0) return text;

  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text },
        ...images.map((image) => ({ type: 'input_image' as const, image: image.dataUrl, detail: 'high' })),
      ],
    },
  ];
}

function formatPastedImageContext(images: PastedImage[]): string {
  if (images.length === 0) return '';

  const lines = images.map((image, index) => {
    return `- [${index + 1}] ${image.name} (${image.type}, ${image.size} bytes)`;
  });

  return [
    'Pasted screenshots/images are attached to this user message.',
    'Use them as visual evidence when the model runtime supports image input. If the screenshot text is unclear, ask for the original YAML/Lua text or a higher-resolution image.',
    ...lines,
  ].join('\n');
}

async function planKnowledgeQueries(
  message: string,
  env: AgentEnv,
  signal: AbortSignal | undefined,
  tracer: any,
): Promise<string[]> {
  const fallback = [message];
  const systemPrompt = [
    'You generate documentation retrieval queries for an oh-my-rime support agent.',
    'Return JSON only: {"queries":["..."]}.',
    'Return one or two concise Chinese or English search queries, not an answer or diagnosis.',
    'Preserve exact product names, versions, operating systems, error symptoms, file names, and configuration keys from the user message.',
    'Do not add facts, causes, remedies, or unsupported terms that were not present in the user message.',
  ].join('\n');

  const run = async (span?: any) => {
    try {
      const client = createGatewayClient(env);
      const response = await client.chat.completions.create(
        {
          model: resolveGatewayModelName(env),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 180,
          temperature: 0,
        },
        { signal },
      );
      const parsed = JSON.parse(response.choices[0]?.message?.content ?? '{}');
      const plannedQueries: unknown[] = Array.isArray(parsed.queries) ? parsed.queries : [];
      const queries: string[] = plannedQueries.filter(
        (query: unknown): query is string => typeof query === 'string' && Boolean(query.trim()),
      );
      const merged = [message, ...queries.map((query) => query.trim())];
      const unique = [...new Set(merged)].slice(0, MAX_KNOWLEDGE_QUERIES);
      span?.setAttributes?.({ 'kb.query_plan.count': unique.length });
      return unique;
    } catch {
      span?.setAttributes?.({ 'kb.query_plan.fallback': true });
      return fallback;
    }
  };

  if (!tracer) return run();
  return tracer.span('plan_knowledge_queries', run, { 'kb.query_plan.message_chars': message.length });
}

function getDocumentationBrowserTools(context: any, knowledge: KnowledgeResult) {
  if (knowledge.relevant || typeof context.tools?.browser !== 'function') return [];
  try {
    const tools = context.tools.browser();
    return Array.isArray(tools) ? tools : [];
  } catch {
    return [];
  }
}

function estimateDataUrlBytes(dataUrl: string, mediaType: string): number | null {
  const prefix = `data:${mediaType};base64,`;
  if (!dataUrl.startsWith(prefix)) return null;

  const base64 = dataUrl.slice(prefix.length);
  if (base64.length === 0 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    return null;
  }

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

function sanitizeImageName(name: string): string {
  return name.replace(/[^\w\u4e00-\u9fff .-]/g, '_').slice(0, 80) || 'pasted-image';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function* runOpenAIToolChat(
  env: AgentEnv,
  contextEnv: Record<string, string | undefined>,
  systemPrompt: string,
  userInput: string,
  pastedImages: PastedImage[],
  tracer: any,
  signal?: AbortSignal,
  sandbox?: any,
) {
  const client = createGatewayClient(env);
  const model = resolveGatewayModelName(env);
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: buildOpenAIUserContent(userInput, pastedImages) },
  ];
  const tools = createRimeOpenAITools();
  const calledTools = new Set<string>();

  let accumInputTokens = 0;
  let accumOutputTokens = 0;

  for (let turn = 0; turn < MAX_MODEL_TOOL_TURNS; turn += 1) {
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

      const output = await executeToolWithTelemetry(
        name,
        args,
        { env: contextEnv, signal, sandbox },
        tracer,
      );
      yield sseEvent({ type: 'tool_result', name, content: formatToolUserSummary(name, output) });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: output,
      });
    }
  }

  yield sseEvent({ type: 'error_message', content: 'Tool loop exceeded maximum turns.' });
}

async function executeToolWithTelemetry(
  name: string,
  args: Record<string, unknown>,
  options: Parameters<typeof executeRimeOpenAITool>[2],
  tracer: any,
): Promise<string> {
  const startedAt = Date.now();
  const run = async (span?: any) => {
    const output =
      name === 'search_docs'
        ? formatKnowledgeContext(
            await queryKnowledgeWithTelemetry(String(args.query ?? ''), options.env, options.signal, tracer, {
              source: 'tool:search_docs',
            }),
          )
        : await executeRimeOpenAITool(name, args, options);
    annotateToolSpan(span, name, args, output, Date.now() - startedAt);
    logger.log('tool_call', buildToolLogPayload(name, args, output, Date.now() - startedAt));
    return output;
  };
  if (!tracer) return run();

  return tracer.span(`tool:${name}`, run, {
    'tool.name': name,
    'tool.args.summary': summarizeToolArgs(args),
  });
}

async function judgeOffTopicWithTelemetry(message: string, env: AgentEnv, tracer: any): Promise<boolean> {
  const startedAt = Date.now();
  const attrs = {
    'judge.name': 'off_topic',
    'judge.message_chars': message.length,
  };

  const run = async (span?: any) => {
    const offTopic = await judgeOffTopic(message, env);
    const durationMs = Date.now() - startedAt;
    annotateJudgeSpan(span, offTopic, durationMs);
    logger.log('judge_off_topic', {
      off_topic: offTopic,
      duration_ms: durationMs,
      message_chars: message.length,
    });
    return offTopic;
  };

  if (!tracer) return run();
  return tracer.span('judge_off_topic', run, attrs);
}

function annotateJudgeSpan(span: any, offTopic: boolean, durationMs: number) {
  if (!span?.setAttributes) return;

  try {
    span.setAttributes({
      'judge.off_topic': offTopic,
      'judge.result': offTopic ? 'off_topic' : 'on_topic',
      'judge.duration_ms': durationMs,
    });
  } catch {
    // Observability should never interrupt the user-facing stream.
  }
}

async function queryKnowledgeWithTelemetry(
  query: string,
  env: Record<string, string | undefined>,
  signal: AbortSignal | undefined,
  tracer: any,
  meta: { source: string; conversationId?: string },
): Promise<KnowledgeResult> {
  const startedAt = Date.now();
  const attrs = {
    'kb.query_chars': query.length,
    'kb.source': meta.source,
    ...(meta.conversationId ? { 'agent.conversation_id': meta.conversationId } : {}),
  };

  const run = async (span?: any) => {
    const result = await queryOhMyRimeKnowledgeBase(query, env, signal);
    const durationMs = Date.now() - startedAt;
    annotateKnowledgeSpan(span, result, durationMs);
    logger.log('knowledge_base_query', buildKnowledgeLogPayload(query, result, durationMs, meta));
    return result;
  };

  if (!tracer) return run();
  return tracer.span('knowledge_base_query', run, attrs);
}

function annotateKnowledgeSpan(span: any, result: KnowledgeResult, durationMs: number) {
  if (!span?.setAttributes) return;

  const attrs: Record<string, string | number | boolean> = {
    'kb.available': result.available,
    'kb.hit_count': result.hits.length,
    'kb.duration_ms': durationMs,
    'kb.hits.summary': truncateText(
      result.hits.slice(0, MAX_OBSERVED_KB_HITS).map((hit, index) => hitToObservation(hit, index + 1)),
      3000,
    ),
  };

  if (result.warning) {
    attrs['kb.warning'] = truncateText(result.warning, 400);
  }

  result.hits.slice(0, MAX_OBSERVED_KB_HITS).forEach((hit, index) => {
    const prefix = `kb.hit.${index + 1}`;
    attrs[`${prefix}.title`] = truncateText(hit.title || '(untitled)', 160);
    if (hit.url) attrs[`${prefix}.url`] = truncateText(hit.url, 300);
    if (typeof hit.score === 'number') attrs[`${prefix}.score`] = hit.score;
    attrs[`${prefix}.content_chars`] = hit.content.length;
    attrs[`${prefix}.preview`] = truncateText(normalizeWhitespace(hit.content), KB_TRACE_PREVIEW_CHARS);
  });

  try {
    span.setAttributes(attrs);
  } catch {
    // Observability should never interrupt the user-facing stream.
  }
}

function buildKnowledgeLogPayload(
  query: string,
  result: KnowledgeResult,
  durationMs: number,
  meta: { source: string; conversationId?: string },
) {
  return {
    source: meta.source,
    conversation_id: meta.conversationId,
    query_chars: query.length,
    available: result.available,
    hit_count: result.hits.length,
    warning: result.warning,
    duration_ms: durationMs,
    hits: result.hits.slice(0, MAX_OBSERVED_KB_HITS).map((hit, index) => hitToObservation(hit, index + 1)),
  };
}

function buildContextCompositionAttributes(input: {
  knowledge: KnowledgeResult;
  extraContext?: string;
  hasUploadedConfigFiles: boolean;
}): Record<string, string | number | boolean> {
  return {
    'context.knowledge_available': input.knowledge.available,
    'context.knowledge_hit_count': input.knowledge.hits.length,
    'context.knowledge_chars': formatKnowledgeContext(input.knowledge).length,
    'context.extra_chars': input.extraContext?.length ?? 0,
    'context.has_uploaded_files': input.hasUploadedConfigFiles,
    'kb.available': input.knowledge.available,
    'kb.hit_count': input.knowledge.hits.length,
    'kb.injected_context_chars': formatKnowledgeContext(input.knowledge).length,
    'kb.hits.summary': truncateText(
      input.knowledge.hits.slice(0, MAX_OBSERVED_KB_HITS).map((hit, index) => hitToObservation(hit, index + 1)),
      3000,
    ),
  };
}

function formatKnowledgeUserSummary(result: KnowledgeResult): string {
  if (!result.available) {
    return `知识库当前不可用：${result.warning ?? '未知原因'}`;
  }

  if (!result.hits.length) {
    return '知识库未命中与当前问题相关的资料，将停止生成未经证实的配置。';
  }

  return `命中 ${result.hits.length} 条知识库内容，已注入 prompt。`;
}

function formatToolUserSummary(name: string, output: string): string {
  if (name === 'recipe') return '已匹配内置配置配方。';
  if (name === 'check_yaml') return summarizeYamlCheck(output);
  if (name === 'target_file') return summarizeTargetFile(output);
  if (name === 'make_patch') return '已生成 YAML patch。';
  if (name === 'resolve_client') return '已识别 Rime 客户端。';
  if (name === 'search_docs') return summarizeSearchDocs(output);
  return truncateText(output, 180);
}

function summarizeYamlCheck(output: string): string {
  try {
    const parsed = JSON.parse(output);
    return parsed.ok ? 'YAML 静态检查通过。' : `YAML 静态检查发现问题：${parsed.summary ?? '请查看最终说明。'}`;
  } catch {
    return '已完成 YAML 静态检查。';
  }
}

function summarizeTargetFile(output: string): string {
  try {
    const parsed = JSON.parse(output);
    return parsed.targetFile ? `已确认建议修改文件：${parsed.targetFile}。` : '已确认建议修改文件。';
  } catch {
    return '已确认建议修改文件。';
  }
}

function summarizeSearchDocs(output: string): string {
  const matches = output.match(/^\[\d+\]/gm);
  return matches?.length ? `命中 ${matches.length} 条补充文档内容，已注入工具上下文。` : '已检索补充文档内容。';
}

function annotateToolSpan(
  span: any,
  name: string,
  args: Record<string, unknown>,
  output: string,
  durationMs: number,
) {
  if (!span?.setAttributes) return;

  try {
    span.setAttributes({
      'tool.name': name,
      'tool.duration_ms': durationMs,
      'tool.args.summary': summarizeToolArgs(args),
      'tool.output_chars': output.length,
      'tool.output.preview': summarizeToolOutput(name, output),
    });
  } catch {
    // Observability should never interrupt the user-facing stream.
  }
}

function buildToolLogPayload(
  name: string,
  args: Record<string, unknown>,
  output: string,
  durationMs: number,
) {
  return {
    name,
    args: summarizeToolArgs(args),
    duration_ms: durationMs,
    output_chars: output.length,
    output_preview: summarizeToolOutput(name, output),
  };
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(args)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, describeToolArgument(value)]),
    ),
  );
}

function describeToolArgument(value: unknown): string {
  if (typeof value === 'string') return `string(${value.length})`;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return 'null';
  return typeof value;
}

function summarizeToolOutput(name: string, output: string): string {
  if (name === 'check_yaml' || name === 'make_patch') {
    return `[redacted ${name} output; ${output.length} chars]`;
  }
  return truncateText(normalizeWhitespace(output), 800);
}

function hitToObservation(hit: KnowledgeHit, rank: number) {
  return {
    rank,
    title: hit.title || '',
    url: hit.url || '',
    score: hit.score,
    content_chars: hit.content.length,
    preview: normalizeWhitespace(hit.content).slice(0, KB_TRACE_PREVIEW_CHARS),
  };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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

async function judgeOffTopic(message: string, env: AgentEnv): Promise<boolean> {
  const client = createGatewayClient(env);
  const model = resolveGatewayModelName(env);
  
  const systemPrompt = `You are a strict classifier. Determine if the user's message is asking for general programming code/scripts (such as writing a general Python script, a web application, Java/C++/JS code, algorithms, etc. that are NOT related to Rime input method configuration) or is completely unrelated to the Rime input method / oh-my-rime distribution.

ON-TOPIC examples:
- "如何配置小狼毫横排显示？"
- "修改 squirrel.custom.yaml 候选词数量"
- "写一个脚本来一键安装/同步我的 Rime 配置" (specifically for Rime)
- "Rime 词库怎么导入？"

OFF-TOPIC examples:
- "帮我用 Python 写一个遍历脚本" (general programming)
- "JavaScript 如何实现深拷贝？" (general programming)
- "唐朝的历史是什么？" (general knowledge)
- "如何做红烧肉？" (cooking)

Respond ONLY with a JSON object:
{"off_topic": true} or {"off_topic": false}`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 100,
      temperature: 0,
    });
    const text = response.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(text);
    return parsed.off_topic === true;
  } catch (err) {
    // fail-closed：分类调用失败（限流/网络故障）时视为 off-topic，走安全边界答复，
    // 避免对可能越界的问题浪费 token 走完整检索。明显 Rime 问题已在 LLM 调用前 return false，不受影响。
    logger.error('Failed to judge off-topic:', err);
    return true;
  }
}
