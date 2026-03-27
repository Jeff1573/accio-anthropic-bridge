# Accio Anthropic Bridge

把 Anthropic / OpenAI 风格请求桥接到 Accio 的本地登录态和本地网关的本地代理。

这个仓库现在不再只是 PoC。当前默认工作模式是：

- 优先直连 `https://phoenix-gw.alibaba.com/api/adk/llm`
- 复用 Accio 桌面端当前登录态
- 如果直连不可用，再回退到 Accio 本地 WebSocket `sendQuery`

已经补上的关键能力包括：

- Anthropic Messages API 可用子集
- OpenAI Chat Completions 兼容接口
- 会话复用
- direct LLM tool use / tool result 映射
- 更细的错误分类和本地重试
- 自动发现可用的 Accio `agent/source/workspace`
- 本地 Accio 鉴权复用探测

## 免责申明

在使用这个项目之前，请先接受下面这些边界：

- 这是非官方、逆向分析得到的桥接方案，不代表 Accio、Anthropic、OpenAI 或阿里巴巴的官方立场
- Accio 本地接口、上游网关协议、模型名、认证字段都可能随桌面端版本更新而失效，这个仓库不承诺长期稳定
- 本项目会复用你当前机器上的 Accio 登录态；如果你把日志、调试输出、代理请求或错误堆栈暴露给他人，可能间接泄露敏感认证信息
- 是否允许这样复用登录态、转发请求、桥接第三方协议，取决于你自己的使用场景以及相关服务条款；合规、风控、账号封禁、额度异常等风险由使用者自行承担
- 如果你将这个项目用于牟利、收费服务、商业分发、代充能力、账号转售或其他商业化变现用途，因此引发的法律、合规、风控、封号、索赔或其他后果，均由使用者自行承担
- 本项目仅适合本地研究、协议验证和个人实验环境，不建议在生产环境、多人共享环境或高权限账号环境直接使用
- 如果你不清楚某条调用是否会触发上游计费、审计或风控，请先不要使用

## 已验证链路

Accio 桌面端本地暴露了两类入口：

- HTTP: `http://127.0.0.1:4097`
- WebSocket: `ws://127.0.0.1:4097/websocket/connect?clientId=...`

这个代理已验证本地 gateway 链路：

1. 外部进程可以直接访问 `127.0.0.1:4097`
2. 外部进程可以直接建立 `/websocket/connect`
3. 外部进程可以发送 `sendQuery`
4. 可以收到 `ack` / `event.append` / `event.finished` / `channel.message.created`
5. 请求结果会写入 Accio 本地 conversation 存储，可被代理再次读取用于补全 tool 映射

## Accio 鉴权复用现状

关于“能不能直接利用 Accio 的认证信息请求上游”这件事，现在结论已经从“待验证”变成了“已验证可行”。

- Accio 桌面端本地网关会维护登录态，默认网关仍在 `http://127.0.0.1:4097`
- 本地可直接访问：
  - `GET /auth/status`
  - `GET /auth/user`
  - `GET /debug/auth/status`
  - `GET /debug/auth/http-log`
  - `GET /debug/auth/ws-status`
  - `POST /debug/auth/refresh`
  - `POST /debug/auth/fetch-user`
- 本地网关还暴露了 `POST /upload`，会直接拿本地 Accio `Cookie` 转发到 `https://filebroker.accio.com/x/upload`
- 从桌面端源码可以确认：
  - Accio 本地确实保存 `accessToken` / `refreshToken` / `cookie`
  - 请求 `phoenix-gw.alibaba.com` 时，会把 `accessToken` 注入 POST body
  - 同时会从 `cookie` 里提取 `cna`，带到 `x-cna` 请求头
  - 还会自动补 `x-utdid` / `x-language` / `x-app-version` / `x-os`

更关键的是，已经做过真实请求验证：

- `GET /debug/auth/ws-status` 会暴露带 `accessToken` 的上游 WebSocket URL
- `GET /debug/auth/http-log` 会暴露带原始 `accessToken` 的上游 HTTP 请求日志
- 外部进程已经成功直接调用：
  - `POST https://phoenix-gw.alibaba.com/api/auth/userinfo`
  - `POST https://phoenix-gw.alibaba.com/api/adk/llm/generateContent`

也就是说，这个桥现在已经可以直接复用 Accio 桌面端当前登录态请求上游 LLM，不再只是通过本地 websocket 曲线触发。

## 当前支持

### Anthropic 兼容

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- 非流式
- SSE 流式
- 原生 `tool_use`
- 原生 `tool_result` 继续对话
- Claude 上游事件透传式 SSE
- 响应顶层附加 `accio.*` 调试字段

### OpenAI 兼容

- `GET /v1/models`
- `POST /v1/chat/completions`
- 非流式
- SSE 流式
- `tools`
- `tool_calls`
- 响应顶层附加 `accio.*` 调试字段

### 额外能力

- `ACCIO_TRANSPORT=auto|direct-llm|local-ws`
- `x-accio-session-id` / `x-session-id` 会话复用
- `x-accio-conversation-id` 直接绑定已有 conversation
- 自动发现 Accio 本地账号、agent、workspace、source
- 对本地网关超时/连接失败/429/5xx 做错误分类
- 对可重试错误做指数退避重试
- `GET /debug/accio-auth` 本地鉴权探测

## 仍然不是完整兼容

当前还不是官方 Anthropic / OpenAI 的 100% 完整实现，限制包括：

- 只有 Claude 族模型在 Anthropic 流式下能做到接近原生的 SSE 透传
- OpenAI 兼容接口当前是“OpenAI 协议适配 + Claude 上游执行”，不是直接调用 OpenAI 官方模型
- 图片 block 还没有做完整上传桥接，当前仍偏向文本 / tool use 场景
- `x-accio-session-id` 在 direct LLM 模式下只是桥接层会话标识，不对应 Accio cloud conversation

## 代理原理

### 1. 为什么现在有两条执行链路

当前代理支持两种后端：

- `direct-llm`
  - 直接请求 `phoenix-gw` 的 `/api/adk/llm/generateContent`
  - 复用 Accio 桌面端本地登录态
  - tool use / tool result 语义最完整
- `local-ws`
  - 通过 Accio 本地 WebSocket `sendQuery` 触发 agent
  - 保留 Accio conversation / session 复用能力

默认 `ACCIO_TRANSPORT=auto`，会先尝试 `direct-llm`，失败后再回退到 `local-ws`。

### 2. direct LLM 如何工作

收到 Anthropic 或 OpenAI 请求后，代理会：

1. 从本地 `debug/auth/ws-status` / `debug/auth/http-log` 复用当前登录态
2. 把 Anthropic/OpenAI 的消息、工具、tool result 转成 Accio ADK LLM 请求
3. 直接请求 `phoenix-gw` 的 `/api/adk/llm/generateContent`
4. 把返回的 Claude / Accio SSE 事件重新封装成 Anthropic 或 OpenAI 兼容响应

### 3. WebSocket 回退模式如何工作

当 direct LLM 不可用时，代理仍然可以：

1. 根据 `session_id` 或 `conversation_id` 决定复用旧 conversation，或创建新 conversation
2. 连接 Accio 本地 WebSocket
3. 发送 `sendQuery`
4. 收集 `append/finished`
5. 回读 Accio 本地 conversation 文件，补全 `tool_calls` 和 `tool_results`

### 4. 自动发现策略

如果你不手动配置 `ACCIO_*` 变量，代理会优先选择：

1. 有可用 DM/source 记录的账号
2. 该账号下的可用 agent/profile
3. agent 的默认 workspace

这个策略比原来的硬编码强，但依然是启发式，不是官方稳定 API。

## 目录结构

```text
accio-anthropic-bridge/
  .env.example
  .gitignore
  package.json
  .data/
    sessions.json
  src/
    accio-client.js
    anthropic.js
    direct-llm.js
    discovery.js
    jsonc.js
    openai.js
    server.js
    session-store.js
```

## 启动

```bash
cd /Users/snow/accio-anthropic-bridge
npm start
```

`npm start` 现在会先检查仓库根目录下是否已有 `.env`：

- 没有 `.env` 时，自动执行一次 `npm run setup`
- 已有 `.env` 时，直接启动，不覆盖你手工改过的配置

`npm run setup` 和 `npm run init-env` 等价，都会自动扫描本机 `~/.accio`，生成当前机器专用的 `.env`。

脚本优先级如下：

1. 如果本地 Accio 网关 `http://127.0.0.1:4097` 可访问，优先读取当前登录态
2. 如果本地网关暂时不可访问，再回退到 `~/.accio/accounts/*` 的最近活跃账号、最近 session、最近 workspace 进行推断

所以大多数场景下，不需要手工填这些 `ACCIO_*` 环境变量。

如果你只想预览自动发现结果、不写入文件：

```bash
npm run init-env -- --print
```

如果 `.env` 已存在，但你想重新生成：

```bash
npm run init-env -- --force
```

如果你只是想单独生成或重建 `.env`，仍然可以直接执行 `npm run setup`。

可选环境变量：

```bash
ACCIO_TRANSPORT=auto
ACCIO_DIRECT_LLM_BASE_URL=https://phoenix-gw.alibaba.com/api/adk/llm
```

默认监听：

```text
http://127.0.0.1:8082
```

## 本地鉴权探测

桥接自身新增了一个探测端点，用来快速判断当前机器上的 Accio 本地鉴权能否复用：

```bash
curl http://127.0.0.1:8082/debug/accio-auth
```

这个接口会汇总：

- 桥接访问的 Accio 本地网关地址
- `GET /auth/status` 的结果
- `GET /debug/auth/status` 的结果
- 是否能直接复用登录态打上游 LLM

它的目标不是导出敏感凭证，而是给你一个明确结论：

- 当前有没有登录态
- 本地网关有没有持有 auth material
- 当前桥是否已经具备 direct LLM 复用条件

## 健康检查

```bash
curl http://127.0.0.1:8082/healthz
```

返回内容里会带：

- 当前使用的 `agentId`
- 自动发现到的 `accountId/source`
- session store 路径和计数
- Accio 本地登录状态
- Accio 本地 debug auth 摘要
- direct LLM 是否可用

## Anthropic 请求示例

### 最简单文本请求

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "accio-bridge",
    "max_tokens": 256,
    "messages": [
      {
        "role": "user",
        "content": "请只回复 OK"
      }
    ]
  }'
```

### 会话复用

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-accio-session-id: demo-session' \
  -d '{
    "model": "accio-bridge",
    "messages": [
      {
        "role": "user",
        "content": "请只回复 SECOND"
      }
    ]
  }'
```

响应头会返回：

- `x-accio-conversation-id`
- `x-accio-session-id`

注意：

- `local-ws` 模式下，这两个值会绑定到 Accio 本地 conversation
- `direct-llm` 模式下，`x-accio-session-id` 只是桥接层 session 复用标识

### 工具映射

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "accio-bridge",
    "tools": [
      {
        "name": "shell_echo",
        "description": "echo a string",
        "input_schema": {
          "type": "object",
          "properties": {
            "text": { "type": "string" }
          },
          "required": ["text"]
        }
      }
    ],
    "messages": [
      {
        "role": "user",
        "content": "请在回答前先调用一个工具，然后告诉我你调用了什么。"
      }
    ]
  }'
```

当前响应会带两层信息：

- 标准 Anthropic `content[].tool_use`
- 自定义 `accio.tool_results`

## OpenAI 请求示例

### Chat Completions

```bash
curl http://127.0.0.1:8082/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "accio-bridge",
    "messages": [
      {
        "role": "user",
        "content": "请只回复 OK"
      }
    ]
  }'
```

### 复用 session

```bash
curl http://127.0.0.1:8082/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-session-id: demo-openai' \
  -d '{
    "model": "accio-bridge",
    "messages": [
      {
        "role": "user",
        "content": "请只回复 OK"
      }
    ]
  }'
```

## Claude Code 接入

如果 Claude Code 支持自定义 Anthropic Base URL，可以直接这样连：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8082
export ANTHROPIC_API_KEY=dummy
claude
```

这里的 `ANTHROPIC_API_KEY` 只是为了满足某些客户端的本地校验。代理本身不校验这个值。

## 关键实现文件

- [src/server.js](/Users/snow/accio-anthropic-bridge/src/server.js)
  HTTP 路由、Anthropic/OpenAI 兼容层、错误分类、SSE 输出
- [src/accio-client.js](/Users/snow/accio-anthropic-bridge/src/accio-client.js)
  Accio HTTP/WS 客户端、重试、conversation 回读、tool artifacts 收集
- [src/discovery.js](/Users/snow/accio-anthropic-bridge/src/discovery.js)
  本地 `~/.accio` 自动发现
- [src/session-store.js](/Users/snow/accio-anthropic-bridge/src/session-store.js)
  session 到 conversation 的持久化映射
- [src/anthropic.js](/Users/snow/accio-anthropic-bridge/src/anthropic.js)
  Anthropic 请求压平和响应映射
- [src/openai.js](/Users/snow/accio-anthropic-bridge/src/openai.js)
  OpenAI 请求压平和响应映射

## 已实测结果

本机已经实测通过：

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/messages/count_tokens`
- `POST /v1/messages`
- `POST /v1/chat/completions`
- 相同 `session_id` 复用同一个 `conversation_id`
- 响应中回带 `tool_use` 和 `accio.tool_results`

## 后续还可以继续做

1. 增加图片和多模态映射
2. 把 `tool_result` 也映射成更接近官方协议的往返流程
3. 增加 `/v1/responses` 或更多 OpenAI 兼容端点
4. 在用户显式授权前提下，研究是否增加 Electron helper 去读取本地加密凭证
5. 如果找到 Accio 本地可复用的上游 LLM 代发端点，再尝试做更深的直连适配
6. 增加 conversation 清理和 session 过期策略
7. 增加更细的日志与 debug tracing
