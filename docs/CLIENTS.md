# 客户端接入：Anthropic、OpenAI Responses 与 OpenAI Chat

以下配置假设：

- 公网 API：`https://api.example.com`（如果按协议拆分实例，请替换为对应子域名）
- API Key：管理端生成的有效密钥，形如 `sk-...`
- 模型 ID：管理端“上游模型（最多 5 个）”中的**原样值**

以下示例默认只有一个实例、公网主机名为 `api.example.com`。如果按协议拆分了多个实例，请把所有协议示例中的 `api.example.com` 都替换为对应实例的 `anthropic.` / `responses.` / `chat.` 子域名；本项目的 `tunnel-setup.ps1`/`start.ps1` 每次只管理一个 hostname ingress；命名隧道本身可配置多个主机名，但本项目会拒绝多 hostname 配置。

服务端同时接受：

- Claude Code / Anthropic SDK 常用的 `x-api-key: <key>`
- OpenAI SDK / 部分网关使用的 `Authorization: Bearer <key>`

客户端必须使用与当前激活协议匹配的端点。VeilLink 不做跨协议翻译；例如当前激活 OpenAI Responses 时，`/v1/messages` 会返回 404。

路径兼容：三种协议的端点同时接受标准 `/v1/...` 和不带 `/v1` 的别名（`/messages`、`/responses`、`/chat/completions`、`/models`）；仅**单个**重复前缀 `/v1/v1/...` 会折叠为 `/v1/...`，多级重复（如 `/v1/v1/v1/...`）返回 404；推荐仍按本文档填写 Base URL。

## 一、Anthropic Messages

### Claude Code

#### 方式 A：通过 CC Switch / Magpie 图形界面

CC Switch（4.x）顶部切到 **Claude Code**，点击右上角 **+** 添加供应商，选择自定义/第三方供应商，然后填写：

| 字段 | 值 |
|---|---|
| 名称 | `VeilLink`（任意） |
| Base URL / 请求地址 | `https://api.example.com`（或 `https://anthropic.example.com`） |
| API Key | `sk-...` |
| 上游格式 / API 格式 | `Anthropic Messages`（原生） |
| 模型映射 / 模型 ID | 管理端白名单中的原样 ID |

不要填成 `https://api.example.com/v1/messages`；Claude Code 会自动追加 `/v1/messages`。保存后点击 **测试 → 启用**；CC Switch 会把该供应商写入 Claude Code 配置（通常是 `~/.claude/settings.json` 的 `env` 块）。启用后重启或新建 Claude Code 会话，用 `/status` 检查显示的基础地址。

Magpie 的 Anthropic 供应商界面同理：选 Anthropic 兼容/自定义供应商，填 Base URL、API Key 和白名单模型 ID。

#### 方式 B：环境变量直接验证

Git Bash：

```bash
export ANTHROPIC_BASE_URL="https://api.example.com"
export ANTHROPIC_API_KEY="sk-..."
export ANTHROPIC_MODEL="你的模型白名单 ID"
claude
```

PowerShell：

```powershell
$env:ANTHROPIC_BASE_URL = "https://api.example.com"
$env:ANTHROPIC_API_KEY = "sk-..."
$env:ANTHROPIC_MODEL = "你的模型白名单 ID"
claude
```

也可以使用 `ANTHROPIC_AUTH_TOKEN` 代替 `ANTHROPIC_API_KEY`。

注意：

- 如果 `~/.claude/settings.json` 的 `env` 块已经配置了其他网关，设置文件中的值可能覆盖当前终端环境。验收时以 `/status` 或服务端请求日志为准。
- Claude Code 会发送大量系统提示和工具定义，第一次请求的输入 Token 可能接近 2 万，这是正常的。
- 管理端现在配置的是**模型白名单**，不再把所有客户端模型名统一改写为一个值。Claude Code 发送的模型名必须是白名单中的某个 ID；不在白名单内会返回 404。

#### 可选：设备头绑定

如果管理端给密钥绑定了设备标识，Claude Code 需要额外发送：

```bash
export ANTHROPIC_CUSTOM_HEADERS="X-VeilLink-Device: YOUR-DEVICE"
```

多条自定义头使用换行分隔。若密钥未绑定设备，忽略此项。

#### 常用验收提示词

普通回答：

```text
Reply with exactly: CLAUDE-PUBLIC-OK
```

工具调用（在临时空目录中创建一个 `sample.txt`，内容为 `VEILLINK_TOOL_OK`）：

```text
Read sample.txt and reply with exactly its contents. Do not use any other tool.
```

在非交互模式下可加：

```bash
claude --print --output-format json --max-turns 4 --allowedTools Read \
  "Read sample.txt and reply with exactly its contents."
```

若返回内容与文件一致且退出码为 0，说明公网 SSE、工具调用和多轮往返均正常。

### ZCode 3.18.2

ZCode 的自定义供应商 GUI 支持完整 Base URL、API Key 和自定义模型 ID，但当前版本没有自定义请求头输入框。

1. 打开 ZCode，进入 **设置**。
2. 选择 **基础设置 → 模型设置**。
3. 点击 **添加供应商**。
4. 在“其他”分组选择 **创建自定义供应商**。
5. 将供应商重命名为 `VeilLink`（可选）。
6. **Base URL** 填：

   ```text
   https://api.example.com
   ```

   不要填 `/v1/messages`。ZCode 会自行追加 `/v1` 和 `/messages`。

7. **API 格式**保持 **Anthropic Messages (`/v1/messages`)**。
8. **API Key** 填管理端生成的密钥。
9. 在 **模型列表** 点击 **添加模型**：
   - 模型 ID 填管理端白名单中的原样值，例如 `你的白名单模型 ID`（示例，必须替换为当前管理端实际配置的 ID，否则会返回 404）；
   - 名称/上下文窗口可按 ZCode 要求填写，或先使用默认值。
10. 启用供应商和模型，点击 **测试模型**。
11. 回到对话界面，在模型选择器中选择刚添加的模型。

ZCode 注意事项：

- 供 ZCode 使用的密钥请 **不要绑定设备标识**，因为 GUI 无法发送 `X-VeilLink-Device`。
- ZCode 可能同时发送 `x-api-key` 和 `Authorization: Bearer`；VeilLink 两者都接受。
- ZCode 不依赖 `/v1/models` 自动发现模型；模型 ID 由你手动填写。
- 管理端“网关配置”的**基础地址**只填到 `/v1` 为止（例如 `http://127.0.0.1:3425` 或 `http://127.0.0.1:3425/v1`），不要填 `/v1/messages`、`/v1/responses`、`/v1/chat/completions` 等完整接口路径。

### Anthropic 请求头与版本

- 推荐发送 `anthropic-version: 2026-10-21`；这是 Anthropic TypeScript SDK 1.10.0（2026-11-17）当前使用的版本。未提供时 VeilLink 默认转发 `2026-10-21`。
- `anthropic-beta`、`x-app` 会原样转发。`anthropic-workspace-id`、`anthropic-user-profile-id` 等账户上下文头不转发；上游使用其 API Key 的默认工作区/账户上下文，避免客户端跨租户选择。
- Anthropic API `2026-10-21` 已移除 `temperature`、`top_p`、`top_k`；发送这些参数会由上游返回 400。VeilLink 不添加也不删除这些参数。
- 不要依赖网关改写 `system`、`tools` 或历史消息；这会影响 Anthropic 5.x 的 preserved thinking 前缀校验。
- 图片/文档请使用 base64 或可访问 URL；引用上游 Files API 已存储对象的 `source.type: "file"`/`file_id` 会被网关以 400 拒绝，避免单一上游凭据下的跨密钥文件引用。

## 二、OpenAI Responses

适用于 OpenAI 官方 SDK、Codex 等使用 `/v1/responses` 的客户端。

### 配置

| 字段 | 值 |
|---|---|
| Base URL | `https://api.example.com/v1`（OpenAI SDK 的 `base_url`；不要加 `/v1/responses`） |
| API Key | `sk-...` |
| 模型 | 管理端白名单中的某个 ID |

### 方式 A：Codex + CC Switch 图形界面

适用于用 CC Switch 管理 Codex 供应商的图形界面流程。先确认 VeilLink 管理端“直连协议”为 **OpenAI Responses**，再在 CC Switch 中：

1. 顶部切到 **Codex**，点击右上角 **+** 添加供应商，选择自定义/第三方供应商。
2. 填写名称（如 `VeilLink`）、VeilLink API Key。
3. **Base URL / 请求地址** 填 `https://api.example.com/v1`（必须带 `/v1`；Codex 会在后面追加 `/responses`）。
4. **上游格式 / API 格式** 选 `Responses (原生)`。
5. 在模型映射表里添加模型：菜单显示名任意，**实际请求模型**填管理端白名单中的原样 ID；上下文窗口可按上游能力填写。
6. 保存后点击 **测试 → 启用**。CC Switch 会写入 `%USERPROFILE%\.codex\config.toml`（其中 `wire_api = "responses"`）和 `auth.json`；重启 Codex 使配置生效。
7. 若 Codex 仍提示缺少 API Key，按 CC Switch 的提示在启动终端设置同名 `OPENAI_API_KEY`，值填 VeilLink 密钥。

如果 VeilLink 当前激活的是 **Anthropic Messages**，而你想让 Codex 通过 CC Switch 接入，请把 CC Switch 的 Codex 供应商上游格式改为 **`Anthropic Messages (需开启路由)`**，并在 CC Switch 中开启 **本地路由 / Local Routing**（针对 Codex 启用），让 CC Switch 在客户端侧把 Responses 请求转换为 Anthropic Messages。VeilLink 本身仍只提供当前激活协议，不做跨协议转换；本地路由必须保持运行。

### 方式 B：OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://api.example.com/v1",
    api_key="sk-...",
    default_headers={"X-VeilLink-Device": "YOUR-DEVICE"},  # 仅密钥绑定设备时需要
)

response = client.responses.create(
    model="你的上游模型 ID",
    input="Reply with exactly: RESPONSES-OK",
    max_output_tokens=64,
    store=False,
)
print(response.output_text)
```

### curl

```bash
curl -sS https://api.example.com/v1/responses \
  -H "x-api-key: $VEILLINK_KEY" \
  -H "content-type: application/json" \
  --data '{
    "model": "你的上游模型 ID",
    "input": "Reply with exactly: RESPONSES-OK",
    "max_output_tokens": 64,
    "store": false
  }'
```

### 注意

- Responses 的 `store` 默认是 `true`，上游可能保存响应至少 30 天。需要无状态时显式传 `"store": false`；VeilLink 不会替你改写。
- 模型必须是管理端白名单中的 ID；创建和 compact 要求显式 `model`，缺失或未知模型会在本地返回 400/404，不会转发。`input_tokens` 允许省略 `model`（官方 SDK `inputTokens.count()` 的默认形式），提供时仍校验白名单。
- 流式响应使用命名事件（`event: response.created`、`event: response.completed` 等），正常结束没有 `[DONE]`。
- `/v1/responses/compact` 和 `/v1/responses/input_tokens` 已开放；上游是否实现由上游决定。上游 404 会保留 404 状态并归一化为 OpenAI 错误格式（不原样透传额外字段）。
- 已存储 Response 的获取/删除/取消/input_items 端点**不开放（404）**：单一上游凭据无法按客户端密钥隔离存储对象，开放会导致跨密钥读取/删除/取消。需要时请直连上游或为每个租户使用独立上游账号。
- `previous_response_id` 只接受同一 VeilLink API Key 在本进程内创建的 Response ID；跨密钥或重启后的旧 ID 返回 404。`conversation`、`background: true` 和输入中的 `item_reference`（或带 `id` 但未构成完整可识别输入项的对象（含声明 message/role 却没有 content 的情况））返回 400；请改用无状态输入或 `previous_response_id`。
- `prompt` 复用提示词对象、`file_id`/`file_ids`、`vector_store_ids`、MCP `connector_id`、除 `auto` 外的任何非空 `container`/`container_id` 值，以及 Anthropic `source.type: "file"`、`tool_result` 内的存储引用或内容块中的 `file_id`（工具调用 `tool_use.input` 的参数按 opaque 放行）会被本地拒绝（400）：这些对象属于上游账户级资源，无法按 VeilLink 密钥隔离。例外：OpenAI Code Interpreter 的 `container: "auto"` 或 `{type:"auto"}` 表示请求新建容器，允许透传；工具 `parameters`/`input_schema` 中声明名为 `file_id` 的属性、以及 `file_search.filters` 元数据也不属于运行时存储引用。请使用内联 `instructions`/`input`、base64/外链文件和普通工具定义。
- OpenAI `/v1/models` 的 DELETE 未开放；模型白名单由管理端维护。

## 三、OpenAI Chat Completions

适用于仍使用 `/v1/chat/completions` 的旧客户端。OpenAI 官方建议新项目使用 Responses。

### 配置

| 字段 | 值 |
|---|---|
| Base URL | `https://api.example.com/v1`（OpenAI SDK 的 `base_url`；不要加 `/v1/chat/completions`） |
| API Key | `sk-...` |
| 模型 | 管理端白名单中的某个 ID |

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://api.example.com/v1",
    api_key="sk-...",
    default_headers={"X-VeilLink-Device": "YOUR-DEVICE"},  # 仅密钥绑定设备时需要
)

completion = client.chat.completions.create(
    model="你的上游模型 ID",
    messages=[{"role": "user", "content": "Reply with exactly: CHAT-OK"}],
    max_completion_tokens=64,
)
print(completion.choices[0].message.content)
```

### 注意

- 流式响应是 `data: {...}` 分块，正常结束最后一帧为 `data: [DONE]`；没有 `event:` 行。
- 上游在 `[DONE]` 前中断时，VeilLink 返回 `error` 数据帧并关闭连接，不会补发 `[DONE]`。
- 已存储 completion 的列表/获取/更新/删除/消息端点**不开放**：`GET /v1/chat/completions` 因同一路径的 POST 创建而返回 405，其余返回 404。单一上游凭据无法按客户端密钥隔离存储对象；`store` 字段仍原样转发，但存储对象只能由上游直接管理。
- Chat 创建请求中的 `model` 必须在白名单内；缺失或未知模型会在本地拒绝。
- 不要依赖网关做 Chat → Anthropic / Anthropic → Chat 转换；需要时请在客户端侧使用 CC Switch / Magpie 等工具。

## 四、通用：模型白名单与协议切换

管理端“上游模型”是一个**白名单**：

1. 至少 1 个、最多 5 个；可以少于 5 个。
2. 所有模型共用当前直连协议。
3. 下游请求的 `model` 必须与白名单中的某个值完全一致；VeilLink 不再把任意模型名改写为单一模型。
4. `/v1/models` 只返回白名单；不会暴露上游完整模型目录。
5. 切换协议后，公网端点集合立即变化。例如从 Anthropic 切到 OpenAI Responses 后，`/v1/messages` 返回 404，`/v1/responses` 可用。

如果需要同时使用三种协议，请运行三个独立实例并分别配置子域名（见 [OPERATIONS.md](OPERATIONS.md)）。

## 五、快速自检顺序

### Anthropic 模式

1. 公网根路径返回 JSON 404，而不是管理页面。
2. 无密钥请求 `/v1/messages` 返回 401。
3. 有效密钥 `/v1/models` 返回配置的模型白名单。
4. 有效密钥普通 `/v1/messages` 返回 Anthropic JSON。
5. `stream: true` 时能持续收到 `event: message_start`、`content_block_delta`、`message_stop`。
6. Claude Code `/status` 显示公网 Base URL，普通对话成功。
7. Claude Code 工具调用成功。
8. ZCode 测试模型与普通对话成功。
9. 管理端吊销该密钥后，两端新请求均返回 401。

### OpenAI Responses 模式

1. `/v1/models` 返回 `{"object":"list","data":[...]}`。
2. 无密钥 `/v1/responses` 返回 401，且响应为 OpenAI 错误格式。
3. 有效密钥普通 `/v1/responses` 返回 `object: "response"`。
4. `stream: true` 能收到 `response.created`、`response.output_text.delta`、`response.completed`。
5. 未知模型返回 404。
6. 上游 `/v1/responses/compact` 不存在时，网关保留 404 状态并返回 OpenAI 错误格式，而不是伪造成 200。

### OpenAI Chat 模式

1. `/v1/models` 返回 `{"object":"list","data":[...]}`。
2. 有效密钥普通 `/v1/chat/completions` 返回 `object: "chat.completion"`。
3. `stream: true` 能收到 `chat.completion.chunk` 和 `data: [DONE]`。
4. 上游流截断时能看到 `error` 数据帧，且没有伪造的 `[DONE]`。
5. 未知模型返回 404。
