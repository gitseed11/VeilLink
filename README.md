# VeilLink

VeilLink 1.1.0 是一个运行在 Windows 本机的轻量多协议网关分发器：接入你指定的本地上游网关，以 **Anthropic Messages**、**OpenAI Responses** 或 **OpenAI Chat Completions** 原生协议通过 HTTPS 提供给公网客户端，并用独立 API Key 控制每个使用者。

当前实现以“单实例、单上游、单激活协议、最多 5 个上游模型、多 API Key、本机管理、公网只开鉴权 API”为边界。项目零运行时 npm 依赖，仅使用 Node.js 内置模块。

## 特性

- 三种**协议直连**上游，不做跨协议翻译：
  - Anthropic Messages → Anthropic Messages；
  - OpenAI Responses → OpenAI Responses；
  - OpenAI Chat Completions → OpenAI Chat Completions。
- 管理端可配置 1–5 个上游模型；下游只能选择白名单内的模型，模型名原样转发，不做统一改写。
- `/v1/models` 返回管理端配置的模型白名单，不泄露上游完整模型目录；白名单最多 5 个，因此忽略 `limit`/`after` 等分页参数。模型对象的 `created`/`created_at`/`capabilities` 等字段是合成的展示元数据（Anthropic 形状用 `created_at`，OpenAI 形状用 `created`）。
- Anthropic 模式兼容 Claude Code、ZCode 等使用 `/v1/messages` 的客户端；OpenAI 模式可供 Codex、OpenAI SDK 和兼容客户端使用。
- 单上游、多密钥；密钥可生成、查看、复制、独立吊销，立即生效。
- 公网管理面为零：公网监听器只暴露当前协议对应的推理与模型发现端点。
- 管理端仅绑定 `127.0.0.1`，带管理令牌登录、会话 Cookie、Host/Origin/CSRF 校验。
- 安装目录与数据目录会收紧到当前 Windows 用户、SYSTEM、Administrators。
- API Key 格式为 `sk-` + 24 位安全随机字符，字符集严格为 `0-9 @ # % & a-z A-Z`。
- 密钥与上游密钥使用 AES-256-GCM 加密落盘，认证索引使用 HMAC-SHA256。
- 可选设备头 `X-VeilLink-Device`；未绑定的密钥不校验设备。
- 请求日志只保存元数据，不保存提示词、请求体、响应体或完整密钥。
- 速率限制、并发限制、请求体上限、全局请求体内存预算、上游超时、客户端断开取消。
- Cloudflare Tunnel 出站连接，不开放入站端口；公网 HTTPS 由 Cloudflare 边缘提供。
- 极简本机管理页面，无外部 CDN、无前端依赖。

## 架构

```text
Claude Code / ZCode / Codex / OpenAI SDK / API 客户端
        │ HTTPS
        ▼
Cloudflare 边缘（Universal SSL）
        │ 加密隧道（cloudflared 出站）
        ▼
127.0.0.1:8788  公网 API 监听器
        │ 鉴权、限流、模型白名单、协议直连
        ▼
你填写的本地上游网关（当前仅一种协议）

浏览器 ──► 127.0.0.1:8787  管理监听器（仅本机，不接隧道）
```

管理端和公网 API 使用两个独立的 HTTP 监听器。Cloudflare 隧道只指向公网源站端口（默认 `8788`）；因此即使误配置了 Host，管理端也不会出现在公网。

一个 VeilLink 实例同一时间只激活一种直连协议；切换协议后，公网端点集合随之切换。需要同时提供三种协议时，请为每种协议运行独立实例（不同数据目录、端口和隧道），详见下文“多协议并行与子域名建议”。

## 目录

```text
VeilLink/
├─ src/                 Node.js 服务端
│  ├─ upstream/         Anthropic / OpenAI Responses / OpenAI Chat 直连、SSE、上游 HTTP
│  └─ ...
├─ web/                 仅本机管理前端
├─ assets/              应用图标（PNG / ICO）
├─ scripts/             启动器、快捷方式、启动/停止、云隧道、管理令牌重置、ACL
├─ test/                假上游、单元测试、集成测试
├─ bin/                 cloudflared 下载与校验说明（二进制不入库）
├─ data/                运行时密钥、配置、日志、隧道凭据（自动创建，禁止公开）
├─ docs/                部署、安全、客户端、运维文档
└─ Temp/                临时文件，验收后清理
```

## 快速开始

要求：Windows 10/11、Node.js 22+、PowerShell 7（`pwsh`）。

### 桌面快捷方式（推荐）

双击桌面 **VeilLink** 快捷方式：

- 服务未运行时，会在后台启动服务，并用 Edge 应用窗口打开本机管理页；
- 关闭管理页窗口不会停止服务；
- 服务运行时，Windows 托盘保留 VeilLink 图标，双击图标可重新打开管理页；
- 停止服务：右键托盘图标 → **停止 VeilLink…**，在确认框中选择“是”。这是日常停止服务和 Cloudflare 隧道的正式入口，默认按钮为“否”，不容易误触。

如果桌面或开始菜单快捷方式丢失，可重新创建：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File "C:\VeilLink\scripts\create-shortcuts.ps1"
```

快捷方式图标为 `assets\veillink.ico`，管理页图标为 `web\favicon.png`。

快捷方式/托盘只管理由快捷方式或 `scripts\start.ps1` 启动的实例（命令行带 `--veillink-data-dir` 标记）。如果正在用 `npm start` 前台运行，请先停止该实例，否则快捷方式会提示管理端口被其他程序占用。

### 命令行启动（可选）

前台运行（便于查看日志）：

```powershell
cd "C:\VeilLink"
npm start
```

或后台运行：

```powershell
pwsh -NoProfile -File "C:\VeilLink\scripts\start.ps1"
```

停止后台进程（会弹出确认框）：

```powershell
pwsh -NoProfile -File "C:\VeilLink\scripts\stop.ps1"
```

自动化脚本可加 `-Force` 跳过确认：

```powershell
pwsh -NoProfile -File "C:\VeilLink\scripts\stop.ps1" -Force
```

首次启动会创建：

- 管理地址（默认）：<http://127.0.0.1:8787>（由 `VEILLINK_ADMIN_PORT` 决定）
- 管理令牌：`data\ADMIN_TOKEN.txt`
- 公网 API 端口（默认）：`127.0.0.1:8788`（由 `VEILLINK_PUBLIC_PORT` 决定）
- 安装目录与数据目录 ACL 会自动收紧到当前 Windows 用户、SYSTEM、Administrators。

不要将管理端口（默认 `8787`）映射到公网，也不要让隧道指向管理端口。

### 管理端

1. 打开 <http://127.0.0.1:8787>。
2. 输入 `data\ADMIN_TOKEN.txt` 中的令牌。
3. 在“网关配置”填写：
   - **基础地址**：例如 `http://127.0.0.1:8080` 或 `http://127.0.0.1:11434`。只填到 `/v1` 为止，末尾不要带 `/v1/messages`、`/v1/responses` 或 `/v1/chat/completions`。非本机地址必须使用 HTTPS；明文 HTTP 仅允许 localhost/回环地址。
   - **直连协议**：`Anthropic Messages`、`OpenAI Responses` 或 `OpenAI Chat`。
   - **上游鉴权**：自动、`x-api-key`、Bearer 或“无鉴权”。
   - **上游模型（最多 5 个）**：填写上游实际识别的模型 ID，至少 1 个、最多 5 个。下游只能请求这里的模型；模型名原样转发，不再统一改写。
   - **上游 API Key**：可选；留空会保留原值，勾选“清除”才会删除。建议使用正常长度的供应商密钥（脱敏逻辑要求至少 4 字符）。
   - **公网 API 地址**：例如 `https://api.example.com`，仅用于展示和客户端配置，必须是 HTTPS。
4. 点击“保存配置”，需要时可点击“测试上游”。测试使用模型列表中的**第一个模型**，发送一次小请求（最多 64 token）。
5. 在“API 密钥”中生成密钥。完整密钥只在本机管理页显示；请通过可信渠道发送。

### 密钥与设备头

- 每个密钥独立、可立即吊销；吊销后任何新的推理或模型发现请求都返回 401。
- 生成时可选填设备标识。绑定后，客户端必须发送：

```http
X-VeilLink-Device: YOUR-DEVICE
```

- 设备头是增强项，不是强身份认证；真正的安全边界是独立密钥、熵、限流和撤销。
- 设备头对三种协议都生效。OpenAI SDK 可通过 `default_headers` 设置；Claude Code 可通过 `ANTHROPIC_CUSTOM_HEADERS` 设置；ZCode 3.18.2 的 GUI 目前不能设置自定义请求头，因此供 ZCode 使用的密钥请不要绑定设备。
- Claude Code 示例：

```bash
export ANTHROPIC_CUSTOM_HEADERS="X-VeilLink-Device: YOUR-DEVICE"
```

## 客户端接入

完整的图形界面步骤见 [docs/CLIENTS.md](docs/CLIENTS.md)。

### Anthropic Messages（Claude Code / ZCode）

通过 CC Switch / Magpie 的图形界面选择 Anthropic 兼容供应商，填入：

- Base URL：`https://你的域名`（不要加 `/v1/messages`）
- API Key：`sk-...`
- 模型：管理端模型白名单中的某个 ID

或使用环境变量直接验证：

```bash
export ANTHROPIC_BASE_URL="https://你的域名"
export ANTHROPIC_API_KEY="sk-..."
export ANTHROPIC_MODEL="你的模型白名单 ID"
claude
```

`ANTHROPIC_AUTH_TOKEN` 也可使用（服务端同时接受 `x-api-key` 与 `Authorization: Bearer`）。VeilLink 不再把任意客户端模型名统一改写为单一上游模型，因此请先在管理端把上游实际识别的模型 ID 加入白名单，再把 `ANTHROPIC_MODEL`（或 CC Switch/ZCode 的模型 ID）设置为该白名单中的原样值；只改客户端而不加入白名单会返回 404，网关侧不提供模型别名改写。若本机 `~/.claude/settings.json` 已有网关配置，请注意设置文件可能覆盖进程环境；验收时以界面显示或实际请求日志为准。

### OpenAI Responses（Codex / OpenAI SDK）

- Base URL：`https://你的域名/v1`（OpenAI SDK 的 `base_url`；不要加 `/v1/responses`）
- API Key：`sk-...`
- 模型：管理端模型白名单中的某个 ID

用 CC Switch（4.x）的 GUI 接入 Codex 时：在 **Codex** 页添加自定义供应商，Base URL 填 `https://你的域名/v1`，上游格式选 `Responses (原生)`，模型映射的实际请求模型填白名单 ID；保存后测试并启用。若 VeilLink 当前是 Anthropic 模式，则在 CC Switch 中把上游格式改为 `Anthropic Messages (需开启路由)` 并开启本地路由，由客户端侧完成 Responses ↔ Anthropic 转换；VeilLink 本身不转换协议。详细步骤见 [docs/CLIENTS.md](docs/CLIENTS.md)。

OpenAI Python 示例：

```python
from openai import OpenAI

client = OpenAI(base_url="https://你的域名/v1", api_key="sk-...")
response = client.responses.create(
    model="你的上游模型 ID",
    input="Reply with exactly: RESPONSES-OK",
)
print(response.output_text)
```

注意：Responses API 的 `store` 默认是 `true`，请求可能在上游被保存至少 30 天。需要无状态使用时，请在请求体中显式设置 `"store": false`；VeilLink 不会替客户端改写该字段。

### OpenAI Chat Completions（兼容旧客户端）

- Base URL：`https://你的域名/v1`（不要加 `/v1/chat/completions`）
- API Key：`sk-...`
- 模型：管理端模型白名单中的某个 ID

OpenAI 官方已建议新项目使用 Responses；Chat Completions 仍受支持。VeilLink 只做直连，不做 Chat → Anthropic 或其他跨协议转换。如果客户端只支持另一种协议，请在客户端侧使用 CC Switch / Magpie 等工具转换，而不是让网关中转。

### 多协议并行与子域名建议

一个 VeilLink 实例同一时间只激活一种协议。如果需要同时提供三种协议，建议运行三个实例，每个实例使用独立的 `VEILLINK_DATA_DIR`、`VEILLINK_ADMIN_PORT`、`VEILLINK_PUBLIC_PORT` 和 Cloudflare 隧道，并分别配置：

| 协议 | 建议主机名 | 客户端 Base URL |
|---|---|---|
| Anthropic Messages | `anthropic.example.com`（或保留 `api.example.com` 作为兼容别名） | `https://anthropic.example.com` |
| OpenAI Responses | `responses.example.com` | `https://responses.example.com/v1` |
| OpenAI Chat | `chat.example.com` | `https://chat.example.com/v1` |

如果一次只使用一种协议，保留现有的 `api.example.com` 即可，不需要创建额外子域名。多个实例的隧道分别运行，管理端口不要进入任何隧道。具体端口/实例示例见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## API

公网只开放当前协议对应的端点。推理与模型发现请求都需要有效 API Key；`OPTIONS` 预检和对不存在路径/错误方法的请求会在鉴权前返回 204/404/405。接受：

```http
x-api-key: sk-...
```

或：

```http
Authorization: Bearer sk-...
```

鉴权通过后才会读取请求体；请求体默认上限 100 MB。

### Anthropic Messages 模式

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/messages` | Anthropic Messages，支持 `stream: true` |
| POST | `/v1/messages/count_tokens` | Token 计数；直连上游并原样透传 `input_tokens`/`context_management` 等字段，出错按 Anthropic 错误格式返回，不做本地估算 |
| GET | `/v1/models` | 返回管理端配置的模型白名单 |
| GET | `/v1/models/{model_id}` | 返回白名单中的单个模型；未知模型返回 404 |

调用示例：

```bash
curl -sS https://你的域名/v1/messages \
  -H "x-api-key: $VEILLINK_KEY" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2026-10-21" \
  --data '{
    "model": "你的上游模型 ID",
    "max_tokens": 128,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

说明：

- 请求中的 `anthropic-version`、`anthropic-beta`、`x-app` 会转发给上游；未提供 `anthropic-version` 时默认 `2026-10-21`。`anthropic-workspace-id`、`anthropic-user-profile-id` 等账户上下文头不转发，上游使用其 API Key 的默认工作区/账户上下文，避免客户端跨租户选择。
- VeilLink 不会添加或删除 `temperature`、`top_p`、`top_k` 等采样参数，也不会改写 `system`、`tools` 或历史消息。Anthropic API `2026-10-21` 已移除这三个采样参数，客户端应按目标版本自行决定是否发送。
- 上游的 `anthropic-ratelimit-*` 与 `retry-after` 响应头会尽量转发，便于客户端退避。
- 流式响应保持 Anthropic 事件顺序；上游截断、超时或缺少 `message_stop` 时返回 `error` 事件，不会把截断内容伪装成正常完成。

### OpenAI Responses 模式

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/responses` | 创建 Response，支持 `stream: true` |
| POST | `/v1/responses/compact` | 压缩长对话，返回 `response.compaction` 对象 |
| POST | `/v1/responses/input_tokens` | 统计输入 token；`model` 可选，提供时必须在白名单内 |
| GET | `/v1/models` | 返回管理端配置的模型白名单 |
| GET | `/v1/models/{model_id}` | 返回白名单中的单个模型 |

调用示例：

```bash
curl -sS https://你的域名/v1/responses \
  -H "x-api-key: $VEILLINK_KEY" \
  -H "content-type: application/json" \
  --data '{
    "model": "你的上游模型 ID",
    "input": "Reply with exactly: RESPONSES-OK",
    "max_output_tokens": 64,
    "store": false
  }'
```

说明：

- 请求体原样转发（模型名不重写）；Responses 创建和压缩必须显式带白名单内的 `model`，缺失或未知模型在本地返回 400/404；`/v1/responses/input_tokens` 允许省略 `model`（与官方 SDK 的 `inputTokens.count()` 对齐），如果提供则仍必须在白名单内。不支持仅靠 `prompt`/`conversation` 推导模型。
- 已存储 Response 的获取/删除/取消/input_items 端点**不开放**：网关使用单一上游凭据，上游对象 ID 不按 VeilLink 客户端密钥隔离，开放它们会导致任意有效密钥读取、删除或取消其他客户端创建的存储对象。需要存储生命周期管理时，请直连上游或为每个租户使用独立上游账号。
- `previous_response_id` 只接受**同一 VeilLink API Key 在本进程内创建**的 Response ID；跨密钥或重启后的旧 ID 返回 404。`conversation`、`background: true` 和输入中的 `item_reference`（或带 `id` 但未构成完整可识别输入项的对象（含声明 message/role 却没有 content 的情况））不开放（返回 400），因为 Conversations/后台生命周期和账户级 item 引用未暴露，无法安全隔离。
- 引用上游已存储对象的字段同样不开放（返回 400）：`prompt` 复用提示词对象、`file_id`/`file_ids`、`vector_store_ids`、MCP `connector_id`，以及 `container`/`container_id`（字符串或带 `id`/`file_ids` 的对象）。网关使用单一上游凭据，这些对象不按 VeilLink 密钥隔离；请改用内联 `instructions`/`input`、base64 或外链文件，以及无状态工具参数。
- 流式响应保留 `response.created`、`response.output_text.delta`、`response.completed` / `response.incomplete` / `response.failed` 等事件；正常结束不使用 Chat Completions 的 `[DONE]` 标记。
- 上游流缺少终止事件时返回 `event: error`，不会伪造 `response.completed`。
- `store` 默认由 OpenAI Responses 决定（默认 `true`）；如不希望上游保存，请在请求中显式设置 `false`。

### OpenAI Chat Completions 模式

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | 创建 Chat Completion，支持 `stream: true` |
| GET | `/v1/models` | 返回管理端配置的模型白名单 |
| GET | `/v1/models/{model_id}` | 返回白名单中的单个模型 |

调用示例：

```bash
curl -sS https://你的域名/v1/chat/completions \
  -H "x-api-key: $VEILLINK_KEY" \
  -H "content-type: application/json" \
  --data '{
    "model": "你的上游模型 ID",
    "messages": [{"role": "user", "content": "Reply with exactly: CHAT-OK"}],
    "max_completion_tokens": 64
  }'
```

说明：

- 流式响应使用 `data: {...}` 分块，正常结束的最后一帧是字面量 `data: [DONE]`；Chat Completions 不使用 `event:` 行。
- 上游流若在 `[DONE]` 之前中断，VeilLink 会返回一个 `error` 数据帧并关闭连接，不会补发 `[DONE]` 伪造成功。
- 已是官方弃用参数的 `max_tokens`、`functions`、`function_call` 仍原样转发；新客户端建议使用 `max_completion_tokens` 和 `tools`。
- 已存储 completion 的列表/获取/更新/删除/消息端点**不开放**：网关使用单一上游凭据，无法按 VeilLink 客户端密钥隔离上游存储对象。`store` 字段仍原样转发，但存储对象只能由上游直接管理。

### 错误格式

Anthropic 模式返回 Anthropic 风格：

```json
{"type":"error","error":{"type":"authentication_error","message":"Invalid API key."},"request_id":"vl_..."}
```

OpenAI 模式返回 OpenAI 风格：

```json
{"error":{"message":"Invalid API key.","type":"authentication_error","param":null,"code":null}}
```

常见状态码：400 请求错误、401 无效/吊销密钥、403 设备不匹配、404 路径或模型不存在、405 方法不允许、409 管理端正在切换协议（重试即可）、413 请求过大、415 Content-Type 错误、429 限流、502 上游不可达或上游错误、503 尚未配置网关或模型白名单为空、529 上游过载。`GET /v1/models` 在尚未配置网关时返回 200 空列表（模型发现本身不需要上游）；推理端点此时返回 503。

### 协议边界

- VeilLink 1.1.0 只代理**推理主路径和模型发现**。Anthropic Message Batches、Files、Skills，OpenAI Batch、Files、Evals、Fine-tuning 等资源型/管理型端点不在本版本范围内，会返回 404；需要时请直连上游。
- OpenAI Responses/Chat 的已存储对象生命周期端点（获取、删除、取消、input_items、completion 列表/消息等）**不开放**：Responses 返回 404；Chat 的 `GET /v1/chat/completions` 因同路径 POST 返回 405，其余 Chat 生命周期路径返回 404。单一上游凭据无法按客户端密钥隔离存储对象，开放会造成跨密钥读写/删除。创建、`/v1/responses/compact`、`/v1/responses/input_tokens` 仍可用。
- OpenAI `/v1/models` 的 DELETE 也不开放；模型白名单由管理端配置，删除上游模型不属于网关职责。
- Anthropic `/v1/messages/count_tokens` 直连上游；上游不支持或返回无效数据时返回 502/上游错误，不再用本地字数估算伪造成功。
- 内联内容块、工具定义、图片、文档（base64/URL）、thinking、signature、`store`、`metadata` 等字段按直连协议原样透传；是否支持某种内容/工具由上游决定。
- 引用上游已存储对象的内容会被本地拒绝：`prompt`、`file_id`/`file_ids`、`vector_store_ids`、MCP `connector_id`、已存储 `container`，以及 Anthropic `source.type: "file"`。Files/Vector Stores/Conversations 等资源端点不在本版本范围内，网关使用单一上游凭据，无法验证这些对象是否属于当前 VeilLink 密钥。
- 标准 Anthropic Messages API 没有原生 `video` 内容块；如果客户端发送上游支持的扩展块，VeilLink 会原样转发。
- Cloudflare 免费计划请求体上限约 100 MB，VeilLink 默认同样限制为 100 MB。

## 安全设计

详见 [docs/SECURITY.md](docs/SECURITY.md)。

- 管理端只绑定回环地址，并校验 `Host`、`Origin`、每个会话独立的 CSRF 令牌、管理令牌和 SameSite=Strict 会话 Cookie；管理凭据重置后旧会话立即失效。
- 公网监听器完全不包含管理路由、静态文件或管理 API。
- 模型白名单在本地强制执行：缺失或未知模型在转发前拒绝，避免客户端任意调用上游模型。
- API Key 不写入 URL；日志、错误响应、管理状态均不包含完整客户端密钥。
- 密钥和上游密钥 AES-GCM 加密保存；管理令牌只保存 scrypt 哈希；安装目录与 data 目录的 ACL 会接管所有者、删除白名单外 Allow ACE 和所有显式 Deny ACE，并逐项验证。
- 认证失败限流、每密钥速率/并发限制、请求体上限、上游超时与中断传播；三种协议的流式响应都跨块脱敏上游密钥。
- Cloudflare 命名隧道时，本机不开放入站端口；隧道与 Node 服务通过 watchdog 绑定，服务器退出时自动停止隧道。

## Cloudflare 部署

以下步骤以示例域名 `example.com` 为例；实际域名、注册商、价格和 Cloudflare 账号以你的控制台为准。

固定公网域名需要你本人完成注册与付款。步骤见 [docs/DEPLOY-CLOUDFLARE.md](docs/DEPLOY-CLOUDFLARE.md)。核心步骤：

1. 在腾讯云“域名注册”购买 `.tech` 域名，并在腾讯云控制台把 DNS 服务器改为 Cloudflare 分配的两个 NS。
2. 将域名加入 Cloudflare（免费套餐），等待状态 Active。
3. 在浏览器完成 `cloudflared tunnel login` 授权。
4. 运行：

```powershell
cd "C:\VeilLink"
pwsh -NoProfile -File scripts\tunnel-setup.ps1 -Hostname api.example.com
```

5. 管理端“公网 API 地址”填入 `https://api.example.com`，再双击桌面 VeilLink 快捷方式（或运行 `scripts\start.ps1`）同时启动服务和命名隧道。

命名隧道只指向当前公网源站端口（默认 `http://127.0.0.1:8788`）。管理端端口（默认 `8787`）不进入隧道配置。

如需并行提供三种协议，请按“多协议并行与子域名建议”为每个实例分别创建隧道和主机名；`tunnel-setup.ps1` 每次只配置一个主机名，因此需要为每个实例使用不同的数据目录、端口和 `-TunnelName`（例如 `veillink-responses`）。

## 测试

```bash
npm test
```

测试覆盖：

- API Key 格式、加密持久化、查看、吊销、设备绑定。
- 管理端 Host/Origin/CSRF/会话校验。
- 公网管理面隔离、鉴权、401/403/413/415/429 路径。
- 多模型配置：数量上限、去重、空列表、旧版 `model` 字段迁移、配置文件版本迁移。
- Anthropic 非流式/流式直连、模型白名单、count_tokens、版本/beta 头转发、错误归一化。
- OpenAI Responses 非流式/流式直连、创建/compact/input_tokens、存储生命周期端点默认 404、跨密钥 previous_response_id 拒绝、终止事件与错误帧。
- OpenAI Chat 非流式/流式直连、创建、存储生命周期端点默认 404/405、`[DONE]` 语义、截断失败关闭。
- 三种协议的上游密钥回显、跨块拆分脱敏、thinking/signature/工具参数脱敏。
- 日志脱敏与密钥不落盘。
- 假上游可在 `test/fake-upstream.js` 中扩展。

实际链路验收还应包含：用真实上游分别验证三种协议；用有效密钥调用 Claude Code、Codex 或 OpenAI SDK；吊销后 401；公网访问管理页/管理 API 为 404。

## 运维

- 启动：桌面 VeilLink 快捷方式（推荐）或 `scripts\start.ps1`
- 停止：右键托盘图标 → **停止 VeilLink…**；命令行使用 `scripts\stop.ps1`（加 `-Force` 跳过确认）
- 重置管理令牌：先停止服务，再运行 `npm run admin:reset`；脚本会拒绝在管理端口仍监听时重置，并让旧管理会话失效。令牌始终写入 `data\ADMIN_TOKEN.txt`；交互式终端还会打印。
- 上游密钥无法解密：先停止服务，运行 `npm run upstream:reset` 清除已保存的上游密钥密文（`apiKeyEnc`，无论是否仍可解密），再启动服务并在管理端重新输入上游密钥。该命令同样拒绝在管理端口仍监听时执行。
- 数据备份：完整备份 `data\`；`master.key` 丢失会导致已存的 API Key 和上游密钥无法解密。客户端密钥无法解密时，管理页会提示，需要重新生成密钥或恢复备份的 `master.key`。
- 请求体默认上限 100 MB，同时有 128 MB 的全局并发请求体预算；超出时返回 413/429，避免内存放大。`limits`（请求体、每密钥速率/并发、每 IP 速率、认证失败预算）当前只能编辑 `data\config.json`，管理端没有修改入口；修改后重启服务生效。
- 日志：`data\logs\access.log`（自动轮转）；管理页最多显示最近 100 条请求记录。
- 端口覆盖（可选）：`VEILLINK_ADMIN_PORT`、`VEILLINK_PUBLIC_PORT`、`VEILLINK_DATA_DIR`。`VEILLINK_DATA_DIR` 必须是专用目录，不能是盘符根目录、项目根目录、`%SystemRoot%` 及其子目录，或用户目录/Program Files/AppData/ProgramData 的根目录。`tunnel-setup.ps1` 会把当前的 `VEILLINK_PUBLIC_PORT`（默认 8788）写入隧道配置；`start.ps1` 会校验隧道 service 与当前端口一致，并要求配置保持 `tunnel-setup.ps1` 生成的标准结构。修改端口后建议重新运行 `tunnel-setup.ps1`；手工编辑 `data\tunnel\config.yml` 时不要改变结构，否则隧道会被拒绝启动。**使用自定义数据目录或端口时，`stop.ps1`、`npm run admin:reset` 和 `npm run upstream:reset` 必须在同一终端设置相同的 `VEILLINK_DATA_DIR` / `VEILLINK_ADMIN_PORT`，否则会操作默认 `data`/8787 实例。**

## 已知边界

- 本项目是单管理员、单上游、单激活协议设计，不提供多租户、配额计费、用户注册或 Web 管理公网暴露。
- 一个实例最多配置 5 个上游模型；同一实例的所有模型共用一种直连协议。需要多协议并行时运行多个实例。
- 不做跨协议翻译；客户端协议必须与当前激活协议一致。需要转换时请在客户端侧使用 CC Switch / Magpie 等工具。
- Anthropic Message Batches/Files/Skills、OpenAI Batch/Files/Evals/Fine-tuning 等资源型端点不在 1.1.0 范围内。
- OpenAI Responses/Chat 的已存储对象生命周期端点不开放，避免单一上游凭据下的跨客户端读写；需要时请直连上游。
- Responses `previous_response_id` 的所有权映射只保存在进程内存；服务重启后旧 ID 会被拒绝（404），需要重新发送完整上下文。`conversation`、`background: true`、`item_reference`、`prompt` 对象和上游存储对象引用（`file_id`、`vector_store_ids` 等）不开放。
- 每个实例最多保留 200 个有效（未吊销）API Key；已吊销记录不计入该上限，会保留用于审计。
- 为做跨事件密钥脱敏，Anthropic 流式工具参数会在 `content_block_stop` 前聚合后发出；最终 JSON 完整，但不是逐 token 的即时增量。OpenAI Responses/Chat 流式工具参数保持增量 delta，只对可能跨事件拼接的密钥片段做 holdback 缓冲。
- 上游响应速度、模型能力、工具支持和多模态能力由你的上游网关决定。
- 设备头可被伪造，只作为增强，不作为强设备认证。
- Cloudflare 免费套餐的无 SLA 特性、中国大陆到 Cloudflare 边缘的网络质量可能影响体验；命名隧道比临时隧道稳定。
- 公网 API 必须通过 HTTPS 使用；不要将管理端口或公网源站端口（默认 8787 / 8788）直接映射到公网。

## 合法使用

本项目仅用于你拥有或获得授权的服务。请遵守上游服务条款和当地法律；不要用于未经授权访问、绕过访问控制或规避计费。

## License

MIT License. See [LICENSE](LICENSE). 第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
