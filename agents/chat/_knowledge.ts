import { createLogger, normalizeWhitespace, traced, truncateText } from '../_shared';

const logger = createLogger('chat:knowledge');
const DEFAULT_KNOWLEDGE_BASE_URL =
  'https://api.cnb.cool/Mintimate/rime/DocVitePressOMR/-/knowledge/base/query';
const MAX_OBSERVED_KB_HITS = 5;
const KB_TRACE_PREVIEW_CHARS = 240;

export interface KnowledgeHit {
  title?: string;
  url?: string;
  content: string;
  score?: number;
}

export interface KnowledgeResult {
  available: boolean;
  hits: KnowledgeHit[];
  warning?: string;
  relevant?: boolean;
  queries?: string[];
}

export async function queryOhMyRimeKnowledgeBase(
  query: string,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<KnowledgeResult> {
  const token = env.CNB_KNOWLEDGE_BASE_TOKEN?.trim();
  if (!token) {
    return {
      available: false,
      hits: [],
      warning: 'CNB_KNOWLEDGE_BASE_TOKEN is not configured.',
    };
  }

  const endpoint = env.CNB_KNOWLEDGE_BASE_URL?.trim() || DEFAULT_KNOWLEDGE_BASE_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  const abortFromParent = () => controller.abort();
  signal?.addEventListener('abort', abortFromParent, { once: true });

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        available: false,
        hits: [],
        warning: `Knowledge base request failed with HTTP ${response.status}.`,
      };
    }

    const payload = await response.json();
    return {
      available: true,
      hits: normalizeKnowledgePayload(payload).slice(0, 8),
    };
  } catch (error) {
    const err = error as Error;
    if (signal?.aborted || err.name === 'AbortError') {
      return { available: false, hits: [], warning: 'Knowledge base request aborted.' };
    }
    return { available: false, hits: [], warning: err.message };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromParent);
  }
}

// Wraps queryOhMyRimeKnowledgeBase with tracer span + log emission so every
// call site (pre-answer retrieval planning, the search_docs tool) gets the
// same observability without repeating the span/log boilerplate.
export async function queryKnowledgeWithTelemetry(
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

  return traced(tracer, 'knowledge_base_query', attrs, run);
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

export function hitToObservation(hit: KnowledgeHit, rank: number) {
  return {
    rank,
    title: hit.title || '',
    url: hit.url || '',
    score: hit.score,
    content_chars: hit.content.length,
    preview: normalizeWhitespace(hit.content).slice(0, KB_TRACE_PREVIEW_CHARS),
  };
}

export { MAX_OBSERVED_KB_HITS };

export function formatKnowledgeContext(result: KnowledgeResult): string {
  if (!result.available) {
    return `Knowledge base unavailable: ${result.warning ?? 'unknown reason'}`;
  }

  if (!result.hits.length) {
    return `Knowledge base returned no relevant oh-my-rime document evidence: ${result.warning ?? 'no matching documents.'}`;
  }

  return result.hits
    .map((hit, index) => {
      const title = hit.title ? `Title: ${hit.title}\n` : '';
      const url = hit.url ? `URL: ${hit.url}\n` : '';
      const score = typeof hit.score === 'number' ? `Score: ${hit.score}\n` : '';
      return `[${index + 1}]\n${title}${url}${score}Content: ${truncateText(hit.content, 1600)}`;
    })
    .join('\n\n');
}

export function mergeKnowledgeResults(results: KnowledgeResult[], queries: string[]): KnowledgeResult {
  const availableResults = results.filter((result) => result.available);
  if (availableResults.length === 0) {
    return {
      available: false,
      hits: [],
      warning: results.find((result) => result.warning)?.warning ?? 'Knowledge base unavailable.',
      relevant: false,
      queries,
    };
  }

  // Planned queries improve recall, but may introduce inferred synonyms that are not
  // present in the user's request. Only the original query may promote a hit to
  // answer evidence; otherwise a generic nearby document can become a false proof.
  const identifiers = extractRetrievalIdentifiers(queries.slice(0, 1));
  const uniqueHits = new Map<string, KnowledgeHit>();
  for (const hit of availableResults.flatMap((result) => result.hits)) {
    const key = hit.url || `${hit.title ?? ''}\n${hit.content.slice(0, 240)}`;
    if (!uniqueHits.has(key)) uniqueHits.set(key, hit);
  }

  const rankedHits = [...uniqueHits.values()]
    .map((hit) => ({ hit, matches: countIdentifierMatches(hit, identifiers) }))
    .filter(({ matches }) => identifiers.length === 0 || matches >= minimumIdentifierMatches(identifiers))
    .sort((left, right) => right.matches - left.matches || (right.hit.score ?? 0) - (left.hit.score ?? 0))
    .map(({ hit }) => hit)
    .slice(0, 8);

  if (rankedHits.length === 0) {
    return {
      available: true,
      hits: [],
      warning: 'The knowledge base returned documents, but none matched the request identifiers. No document evidence was injected.',
      relevant: false,
      queries,
    };
  }

  return { available: true, hits: rankedHits, relevant: true, queries };
}

export function buildUnsupportedKnowledgeResponse(result: KnowledgeResult): string {
  if (!result.available) {
    return [
      '当前知识库不可用，因此我暂时无法可靠验证或支持这个场景。',
      '为避免给出错误配置，我不会根据模型记忆猜测配置项；请稍后重试，或补充对应的 oh-my-rime 官方文档与原始配置。',
    ].join('\n\n');
  }

  return [
    '当前知识库没有找到与这个问题相关的资料，因此 oh-my-rime Agent 暂不支持这个场景。',
    '为避免误导，我不会生成或猜测配置项。若你能提供对应的 oh-my-rime 官方文档、原始 YAML/Lua 配置或部署日志，我可以再基于这些证据检查。',
  ].join('\n\n');
}

function extractRetrievalIdentifiers(queries: string[]): string[] {
  const ignoredLatin = new Set([
    'rime',
    'oh-my-rime',
    'knowledge',
    'search',
    'query',
    'input',
    'method',
    'issue',
    'problem',
    'compatibility',
  ]);
  const ignoredChinese = new Set([
    '这个', '这种', '什么', '怎么', '如何', '是否', '可以', '不能', '不会', '问题', '相关', '功能',
    '配置', '设置', '输入', '输入法', '使用', '用户', '进行', '一个', '对应', '支持', '情况', '时候',
  ]);
  const text = queries.join('\n').toLowerCase();
  const latin = (text.match(/[a-z][a-z0-9_-]{2,}|\d+(?:\.\d+)+/g) ?? [])
    .filter((term) => !ignoredLatin.has(term));
  const chinese = (text.match(/[\u3400-\u9fff]{2,}/g) ?? []).flatMap((run) => {
    const grams: string[] = [];
    for (let index = 0; index < run.length - 1; index += 1) {
      const gram = run.slice(index, index + 2);
      if (!ignoredChinese.has(gram)) grams.push(gram);
    }
    return grams;
  });
  return [...new Set([...latin, ...chinese])];
}

function countIdentifierMatches(hit: KnowledgeHit, identifiers: string[]): number {
  const haystack = `${hit.title ?? ''}\n${hit.url ?? ''}\n${hit.content}`.toLowerCase();
  return identifiers.filter((identifier) => haystack.includes(identifier)).length;
}

function minimumIdentifierMatches(identifiers: string[]): number {
  if (identifiers.some((identifier) => /^\d+\.\d+/.test(identifier))) return 1;
  if (identifiers.filter((identifier) => /[\u3400-\u9fff]/.test(identifier)).length >= 5) return 3;
  return identifiers.length >= 3 ? 2 : 1;
}

function normalizeKnowledgePayload(payload: unknown): KnowledgeHit[] {
  const candidates = collectCandidateItems(payload);
  const hits = candidates
    .map(toKnowledgeHit)
    .filter((hit): hit is KnowledgeHit => Boolean(hit?.content.trim()));

  if (hits.length) return hits;

  const fallback = truncateText(payload, 4000);
  return fallback ? [{ content: fallback }] : [];
}

function collectCandidateItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];

  for (const key of ['data', 'results', 'documents', 'chunks', 'items', 'list']) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested;
    if (isRecord(nested)) {
      const deeper = collectCandidateItems(nested);
      if (deeper.length) return deeper;
    }
  }

  return [value];
}

export function convertCnbUrl(text: string): string {
  if (!text) return text;
  return text.replace(
    /https:\/\/cnb\.cool\/mintimate\/rime\/docvitepressomr\/-\/(blob|git\/raw)\/[^/]+\/([^\s\?\#\)]+)/gi,
    (match, type, path) => {
      if (type.toLowerCase() === 'blob') {
        const cleanPath = path.replace(/\.md$/i, '.html');
        return `https://www.mintimate.cc/${cleanPath}`;
      } else {
        return `https://www.mintimate.cc/${path}`;
      }
    }
  );
}

function toKnowledgeHit(item: unknown): KnowledgeHit | null {
  if (typeof item === 'string') return { content: convertCnbUrl(item) };
  if (!isRecord(item)) return null;

  const metadata = isRecord(item.metadata) ? item.metadata : {};
  const document = isRecord(item.document) ? item.document : {};
  
  const rawContent =
    firstString(item.content, item.text, item.chunk, item.page_content, item.summary, document.content, metadata.content) ??
    truncateText(item, 1200);
  const content = convertCnbUrl(rawContent);

  const rawUrl = firstString(item.url, item.href, metadata.url, metadata.link);
  const url = rawUrl ? convertCnbUrl(rawUrl) : undefined;

  return {
    title: firstString(item.title, item.name, metadata.title, metadata.source, metadata.file_path),
    url,
    score: firstNumber(item.score, item.similarity, metadata.score),
    content,
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
