# oh-my-rime Agent

EdgeOne Makers 托管 Agent，用于辅助用户编辑 Rime 和 [oh-my-rime](https://github.com/Mintimate/oh-my-rime) 配置。

## Endpoints

- `POST /chat`: SSE 对话端点。请求头必须带 `makers-conversation-id`。
- `POST /stop`: 取消正在运行的会话。不要带 `makers-conversation-id` 请求头，只在 body 中传 `conversation_id`。

`/chat` SSE 会返回这些事件类型：

- `thinking`: 可展示的推理摘要/决策过程
- `tool_call`: 工具调用开始
- `tool_result`: 工具调用结果
- `ai_response`: 最终回答增量
- `usage`: token 用量
- `ping`: 心跳
- `error_message`: 错误信息

## Environment

复制 `.env.example` 到 `.env`，或在 EdgeOne Makers 项目环境变量中设置：

```env
AI_GATEWAY_API_KEY=
AI_GATEWAY_BASE_URL=https://ai-gateway.edgeone.link/v1
AI_GATEWAY_MODEL=@makers/deepseek-v4-flash
ENABLE_MODEL_TOOLS=false
CNB_KNOWLEDGE_BASE_URL=
CNB_KNOWLEDGE_BASE_TOKEN=
```

模型通过 [Makers 官方 API](https://pages.edgeone.ai/document/models) 调用，默认使用 `@makers/deepseek-v4-flash`。`AI_GATEWAY_API_KEY` 使用 Makers → Models → API Key 中的官方密钥；自定义网关的旧密钥不能直接用于官方端点。Makers 部署流程可以自动注入网关配置，本地开发可从已绑定项目拉取，或在 `.env` 中填写。`CNB_KNOWLEDGE_BASE_TOKEN` 仍需单独设置。

分类、检索规划和最终回答均使用同一网关。保持非思考模式：DeepSeek 使用 `thinking.type=disabled`，不再发送 Qwen 专属参数；流式用量由 Agent SDK 请求并汇总。

如果模型网关支持 OpenAI tool calling，可以将 `ENABLE_MODEL_TOOLS=true` 打开 Rime 专用工具：

- `search_docs`
- `resolve_client`
- `target_file`
- `make_patch`
- `check_yaml`
- `recipe`

Agent 由 `@openai/agents` 的 Runner 驱动，何时调用哪些工具由模型自主决策（详见 system prompt 中的 tool-use-policy），不再有额外的固定校验层。

每次请求最多执行 6 轮模型调用，第 6 轮关闭工具、使用已有资料生成回答。预检索结果可直接作为依据；`search_docs` 仅用于补充缺失信息，最多调用 2 次，相同查询复用结果。模型仍无法收敛时会返回补充信息提示，不再仅显示 `Max turns exceeded`。可运行 `npm run smoke:agent-loop` 离线验证重复检索、最后一轮回答和异常兜底。

## Local Development

```bash
npm install
PAGES_SOURCE=skills edgeone makers dev
```

类型检查：

```bash
npm run typecheck
```

## Tracing

追踪由 Makers 运行时注入的 `context.tracer` 上报。在 `edgeone makers dev` 输出的地址打开 `/agent-metrics`，或在已部署项目控制台的 Agent → Traces / Metrics 中查看，并按 `conversation_id` 筛选。

- `judge_off_topic`、`plan_knowledge_queries`：直接调用模型的 LLM span，包含模型名、截断后的文本输入输出和 token 用量。
- `openai_agents_run`：覆盖最终回答的完整流式过程，记录事件数、用量、错误和取消状态。标记为 AGENT，具体模型调用由平台自动插桩，避免重复计入 LLM 指标。
- `knowledge_base_query`、`tool:*`：分别标记为 RETRIEVER 和 TOOL。

直接运行 `smoke:chat` 等脚本不会加载 Makers 运行时，也不会注入或上报平台追踪。`npm run smoke:tracing` 使用模拟模型响应和 tracer，离线验证追踪字段以及流式结束、失败、取消时的 span 关闭行为。

## Smoke Test

使用 npm scripts 直接运行（无需启动 dev 服务器）：

```bash
# 对话端点冒烟测试
npm run smoke:chat

# 平台工具注入冒烟测试
npm run smoke:tools
```

或使用 curl 对运行中的 dev 服务器测试：

```bash
curl -N http://localhost:8080/chat \
  -H 'Content-Type: application/json' \
  -H "makers-conversation-id: $(uuidgen)" \
  -d '{"message":"小狼毫如何设置横向候选栏？"}'
```

停止当前会话：

```bash
curl http://localhost:8080/stop \
  -H 'Content-Type: application/json' \
  -d '{"conversation_id":"<same-conversation-id>"}'
```
