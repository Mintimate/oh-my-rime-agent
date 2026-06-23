import OpenAI from 'openai';
import { OpenAIChatCompletionsModel } from '@openai/agents';

const DEFAULT_MODEL = '@makers/deepseek-v4-flash';

export interface AgentEnv {
  AI_GATEWAY_API_KEY: string;
  AI_GATEWAY_BASE_URL: string;
  AI_GATEWAY_MODEL?: string;
}

export function getAgentEnv(contextEnv: Record<string, string | undefined> | undefined): AgentEnv {
  const source = contextEnv ?? {};
  const missing = ['AI_GATEWAY_API_KEY', 'AI_GATEWAY_BASE_URL'].filter((key) => !source[key]?.trim());
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }

  return {
    AI_GATEWAY_API_KEY: source.AI_GATEWAY_API_KEY!,
    AI_GATEWAY_BASE_URL: normalizeOpenAIBaseUrl(source.AI_GATEWAY_BASE_URL!),
    AI_GATEWAY_MODEL: source.AI_GATEWAY_MODEL,
  };
}

export function createGatewayModel(env: AgentEnv) {
  const client = createGatewayClient(env);
  return new OpenAIChatCompletionsModel(client, resolveGatewayModelName(env));
}

export function createGatewayClient(env: AgentEnv) {
  return new OpenAI({
    apiKey: env.AI_GATEWAY_API_KEY,
    baseURL: env.AI_GATEWAY_BASE_URL,
  });
}

export function resolveGatewayModelName(env: AgentEnv): string {
  return env.AI_GATEWAY_MODEL || DEFAULT_MODEL;
}

function normalizeOpenAIBaseUrl(value: string): string {
  return value.trim().replace(/\/chat\/completions\/?$/, '');
}
