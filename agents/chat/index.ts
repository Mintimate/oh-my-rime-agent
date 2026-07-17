import { Agent, run, type AgentInputItem, type Session } from '@openai/agents';
import { createGatewayClient, createGatewayModel, getAgentEnv, resolveGatewayModelName, type AgentEnv } from '../_model';
import { createLogger, createSSEResponse, jsonResponse, sseEvent, createToolCallXmlStreamFilter, traced, truncateText } from '../_shared';
import { buildSystemPrompt, buildUserInput } from './_prompt';
import {
  buildUnsupportedKnowledgeResponse,
  formatKnowledgeContext,
  mergeKnowledgeResults,
  queryKnowledgeWithTelemetry,
  MAX_OBSERVED_KB_HITS,
  hitToObservation,
  type KnowledgeResult,
} from './_knowledge';
import { diagnoseUploadedRimeDirectory } from './_uploads';
import { createRimeTools, formatToolUserSummary, shouldEnableModelTools } from './_tools';

const logger = createLogger('chat');
const MAX_PASTED_IMAGES = 3;
const MAX_PASTED_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PASTED_IMAGE_TOTAL_BYTES = MAX_PASTED_IMAGES * MAX_PASTED_IMAGE_BYTES;
const MAX_PASTED_IMAGE_DATA_URL_CHARS = Math.ceil((MAX_PASTED_IMAGE_BYTES * 4) / 3) + 128;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_EXTRA_CONTEXT_CHARS = 16_000;
const MAX_AGENT_TURNS = 6;
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

          yield* runFinalAgentAnswer(env, systemPrompt, userInput, pastedImages, [], undefined, conversationId, tracer, signal);
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
        }

        const tools = getAgentTools(context, knowledge, env, signal);
        yield* runFinalAgentAnswer(env, systemPrompt, userInput, pastedImages, tools, context.sandbox, conversationId, tracer, signal, context);
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

  return traced(tracer, 'plan_knowledge_queries', { 'kb.query_plan.message_chars': message.length }, run);
}

// Chooses which tool set the final agent gets: Rime-specific config-editing
// tools once we have document evidence for the request, or a fallback
// documentation browser when the knowledge base found nothing relevant.
function getAgentTools(context: any, knowledge: KnowledgeResult, env: AgentEnv, signal: AbortSignal | undefined) {
  if (!knowledge.relevant) {
    return getDocumentationBrowserTools(context);
  }
  if (!shouldEnableModelTools(context.env ?? {})) {
    return [];
  }
  return createRimeTools({ env: context.env ?? {}, signal, sandbox: context.sandbox, tracer: context.tracer });
}

function getDocumentationBrowserTools(context: any) {
  if (typeof context.tools?.browser !== 'function') return [];
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

// Runs the single Agent SDK path used for every answer: off-topic refusals,
// unsupported-knowledge answers with no tools, and normal Rime config-editing
// turns with the Rime tool set attached. Streaming, tool-call events, XML
// filtering, and usage accounting are all handled once here.
async function* runFinalAgentAnswer(
  env: AgentEnv,
  systemPrompt: string,
  userInput: string,
  pastedImages: PastedImage[],
  tools: any[],
  sandbox: any,
  conversationId: string | undefined,
  tracer: any,
  signal?: AbortSignal,
  context?: any,
) {
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
    tools,
  });

  const session: Session | undefined =
    context?.store && conversationId ? context.store.openaiSession(conversationId) : undefined;

  const result = await run(agent, buildAgentUserInput(userInput, pastedImages), {
    stream: true,
    signal,
    session,
    maxTurns: MAX_AGENT_TURNS,
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

  return traced(tracer, 'judge_off_topic', attrs, run);
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
    return { type: 'tool_result', name, content: formatToolUserSummary(name, String(output ?? '')) };
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
    // fail-open：分类调用失败（限流/网络故障）时视为 on-topic，走正常检索流程。
    // 知识库无证据时已有 knowledge.relevant=false 的兜底拒答，比 off-topic 路径再调
    // 一次 LLM 更可靠；明显 Rime 问题已在调用前 return false，不受影响。
    logger.error('Failed to judge off-topic, defaulting to on-topic:', err);
    return false;
  }
}
