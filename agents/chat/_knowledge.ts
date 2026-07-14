import { truncateText } from '../_shared';

const DEFAULT_KNOWLEDGE_BASE_URL =
  'https://api.cnb.cool/Mintimate/rime/DocVitePressOMR/-/knowledge/base/query';

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

  const identifiers = extractRetrievalIdentifiers(queries);
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

function extractRetrievalIdentifiers(queries: string[]): string[] {
  const ignored = new Set([
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
  const text = queries.join('\n').toLowerCase();
  const matches = text.match(/[a-z][a-z0-9_-]{2,}|\d+(?:\.\d+)+/g) ?? [];
  return [...new Set(matches.filter((term) => !ignored.has(term)))];
}

function countIdentifierMatches(hit: KnowledgeHit, identifiers: string[]): number {
  const haystack = `${hit.title ?? ''}\n${hit.url ?? ''}\n${hit.content}`.toLowerCase();
  return identifiers.filter((identifier) => haystack.includes(identifier)).length;
}

function minimumIdentifierMatches(identifiers: string[]): number {
  return identifiers.some((identifier) => /^\d+\.\d+/.test(identifier)) ? 1 : identifiers.length >= 3 ? 2 : 1;
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
