// Use the Makers-injected tracer so manual spans share the platform trace.
// Optional methods also allow direct smoke tests without the Makers runtime.
export type TraceAttributes = Record<string, string | number | boolean>;

export interface TraceSpan {
  setAttributes?(attributes: TraceAttributes): void;
  recordException?(error: Error): void;
  setStatus?(status: { code: number; message: string }): void;
  end?(): void;
}

export function setTraceAttributes(span: TraceSpan | undefined, attributes: TraceAttributes) {
  try {
    span?.setAttributes?.(attributes);
  } catch {
    // Telemetry must not interrupt a response.
  }
}

export function startTraceSpan(tracer: any, name: string, attributes: TraceAttributes): TraceSpan | undefined {
  try {
    return tracer?.startSpan?.(name, attributes);
  } catch {
    return undefined;
  }
}

export function recordTraceError(span: TraceSpan | undefined, error: unknown) {
  const err = error instanceof Error ? error : new Error(String(error));
  setTraceAttributes(span, {
    'error': true,
    'error.type': err.name,
    'error.message': err.message.slice(0, 1000),
  });
  try {
    span?.recordException?.(err);
    span?.setStatus?.({ code: 2, message: err.message });
  } catch {
    // Makers versions exposing only attributes still retain the error details.
  }
}

export function endTraceSpan(span: TraceSpan | undefined) {
  try {
    span?.end?.();
  } catch {
    // Telemetry must not interrupt a response.
  }
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export function usageTraceAttributes(usage: TokenUsage | null, kind: 'llm' | 'agent'): TraceAttributes {
  const attributes: TraceAttributes = {};
  if (usage?.input_tokens !== undefined) {
    attributes[kind === 'llm' ? 'llm.token_count.prompt' : 'agent.usage.input_tokens'] = usage.input_tokens;
  }
  if (usage?.output_tokens !== undefined) {
    attributes[kind === 'llm' ? 'llm.token_count.completion' : 'agent.usage.output_tokens'] = usage.output_tokens;
  }
  if (usage?.total_tokens !== undefined) {
    attributes[kind === 'llm' ? 'llm.token_count.total' : 'agent.usage.total_tokens'] = usage.total_tokens;
  }
  return attributes;
}
