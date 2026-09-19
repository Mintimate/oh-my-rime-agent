import type { Model, ModelRequest, Tool } from '@openai/agents';

export const MAX_AGENT_TURNS = 6;
export const TURN_LIMIT_REPLY = '已完成部分检索，但还没有形成可靠的配置方案。请补充当前使用的输入法客户端、方案名称及相关配置片段，我会据此继续定位；暂不建议直接修改配置。';

const FINAL_ANSWER_INSTRUCTION = [
  'This is the final response turn. No more tool calls are available.',
  'Answer the user now using the supplied knowledge and tool results already in this conversation.',
  'Do not repeat searches or claim a configuration was validated when it was not.',
  'If the evidence is insufficient, state the specific missing fact and ask one focused clarification instead of inventing configuration.',
].join('\n');

// Request-local policy: SDK maxTurns counts model calls, not user messages.
// Keep the last call for a response while preserving every prior tool result.
export function createAgentRunPolicy(baseModel: Model, tools: Tool[]) {
  let modelCalls = 0;
  const prepare = (request: ModelRequest): ModelRequest => {
    modelCalls += 1;
    if (modelCalls < MAX_AGENT_TURNS) return request;
    return {
      ...request,
      tools: [],
      handoffs: [],
      modelSettings: { ...request.modelSettings, toolChoice: 'none' },
      systemInstructions: `${request.systemInstructions ?? ''}\n\n${FINAL_ANSWER_INSTRUCTION}`,
    };
  };

  const model: Model = {
    getResponse: (request) => baseModel.getResponse(prepare(request)),
    getStreamedResponse: (request) => baseModel.getStreamedResponse(prepare(request)),
    getRetryAdvice: baseModel.getRetryAdvice?.bind(baseModel),
  };

  return {
    model,
    tools: tools.map((tool) => tool.type === 'function' ? {
      ...tool,
      isEnabled: async (runContext, agent) =>
        modelCalls < MAX_AGENT_TURNS - 1 && await tool.isEnabled(runContext, agent),
    } satisfies typeof tool : tool),
    get modelCalls() { return modelCalls; },
  };
}
