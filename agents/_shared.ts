export function createLogger(name: string) {
  return {
    log(...args: unknown[]) {
      console.log(`[${name}][${new Date().toISOString()}]`, ...args);
    },
    error(...args: unknown[]) {
      console.error(`[${name}][${new Date().toISOString()}]`, ...args);
    },
  };
}

export function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
  });
}

export function createSSEResponse(
  generator: (signal?: AbortSignal) => AsyncGenerator<string>,
  signal?: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const readableStream = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(sseEvent({ type: 'ping', ts: Date.now() })));
        } catch {
          clearInterval(heartbeat);
        }
      }, 5_000);

      try {
        for await (const chunk of generator(signal)) {
          if (signal?.aborted) break;
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (error) {
        const err = error as Error;
        if (!signal?.aborted && err.name !== 'AbortError' && !err.message?.includes('terminated')) {
          controller.enqueue(encoder.encode(sseEvent({ type: 'error_message', content: err.message })));
        }
      } finally {
        clearInterval(heartbeat);
        if (!signal?.aborted) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        }
        controller.close();
      }
    },
    cancel() {
      // The platform signal handles client disconnect propagation.
    },
  });

  return new Response(readableStream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export function truncateText(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

// Some OpenAI-compatible models emit function calls as XML tags in delta.content
// even when a proper tool_calls array is also produced. Strip those tags so they
// never reach the UI. A tag can be split across streaming chunks (e.g. "<tool_c" +
// "all>"), so the filter must retain state between pushes.
const TOOL_CALL_XML_TAG = /<\/?(?:tool_call|function|parameter)\b[^>]*>/i;
const TOOL_CALL_TAG_PREFIXES = [
  '</tool_call', '<tool_call',
  '</function', '<function',
  '</parameter', '<parameter',
];

export interface ToolCallXmlStreamFilter {
  push(text: string): string[];
  flush(): string[];
}

export function createToolCallXmlStreamFilter(): ToolCallXmlStreamFilter {
  let buffer = '';

  const drain = (): string[] => {
    const out: string[] = [];
    while (buffer) {
      const lt = buffer.indexOf('<');
      if (lt === -1) {
        out.push(buffer);
        buffer = '';
        break;
      }
      if (lt > 0) {
        out.push(buffer.slice(0, lt));
        buffer = buffer.slice(lt);
      }
      const gt = buffer.indexOf('>');
      if (gt === -1) {
        if (couldStartToolCallTag(buffer)) break;
        out.push(buffer);
        buffer = '';
        break;
      }
      const candidate = buffer.slice(0, gt + 1);
      if (TOOL_CALL_XML_TAG.test(candidate)) {
        buffer = buffer.slice(gt + 1);
        continue;
      }
      out.push(candidate);
      buffer = buffer.slice(gt + 1);
    }
    return out;
  };

  return {
    push(text) {
      buffer += text;
      return drain();
    },
    flush() {
      const tail = buffer;
      buffer = '';
      return tail ? [tail] : [];
    },
  };
}

// True when `prefix` could still extend into a tool_call/function/parameter tag,
// so it must be held for the next chunk rather than emitted as plain text.
function couldStartToolCallTag(prefix: string): boolean {
  const lower = prefix.toLowerCase();
  return TOOL_CALL_TAG_PREFIXES.some(
    (tag) => tag.startsWith(lower) || lower.startsWith(tag),
  );
}

