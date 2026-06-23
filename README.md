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
AI_GATEWAY_BASE_URL=
AI_GATEWAY_MODEL=
ENABLE_MODEL_TOOLS=false
CNB_KNOWLEDGE_BASE_URL=
CNB_KNOWLEDGE_BASE_TOKEN=
```

`AI_GATEWAY_API_KEY` 和 `AI_GATEWAY_BASE_URL` 由 Makers 部署流程自动注入；`CNB_KNOWLEDGE_BASE_TOKEN` 需要手动设置。

如果模型网关支持 OpenAI tool calling，可以将 `ENABLE_MODEL_TOOLS=true` 打开 Rime 专用工具：

- `search_docs`
- `resolve_client`
- `target_file`
- `make_patch`
- `check_yaml`
- `recipe`

Agent 会在最终回答前做一次轻量自审：如果配置编辑任务缺少目标文件或 YAML patch 工具结果，会继续补齐工具调用后再回答。

## Local Development

```bash
npm install
PAGES_SOURCE=skills edgeone makers dev
```

类型检查：

```bash
npm run typecheck
```

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
