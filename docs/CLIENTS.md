# 客户端接入：Claude Code 与 ZCode

以下配置假设：

- 公网 API：`https://api.example.com`
- API Key：管理端生成的有效密钥，形如 `sk-...`

服务端同时接受：

- Claude Code 默认的 `x-api-key: <key>`
- ZCode / 部分网关使用的 `Authorization: Bearer <key>`

## Claude Code

### 方式 A：通过 CCswitch / Magpie 图形界面

在 CCswitch 或 Magpie 的 Claude / Anthropic 供应商配置中填写：

| 字段 | 值 |
|---|---|
| Base URL / API 地址 | `https://api.example.com` |
| API Key | `sk-...` |
| API 格式 / 协议 | Anthropic Messages（如界面提供选择） |

不要填成 `https://api.example.com/v1/messages`；客户端会自动追加 `/v1/messages`。

启用该供应商后，重启或新建 Claude Code 会话。使用 `/status` 检查显示的基础地址。

### 方式 B：环境变量直接验证

Git Bash：

```bash
export ANTHROPIC_BASE_URL="https://api.example.com"
export ANTHROPIC_API_KEY="sk-..."
claude
```

PowerShell：

```powershell
$env:ANTHROPIC_BASE_URL = "https://api.example.com"
$env:ANTHROPIC_API_KEY = "sk-..."
claude
```

也可以使用 `ANTHROPIC_AUTH_TOKEN` 代替 `ANTHROPIC_API_KEY`。

注意：

- 如果 `~/.claude/settings.json` 的 `env` 块已经配置了其他网关，设置文件中的值可能覆盖当前终端环境。验收时以 `/status` 或服务端请求日志为准。
- 不要在同一个会话里同时指向多个网关做 A/B 测试；重启会话更可靠。
- Claude Code 会发送大量系统提示和工具定义，第一次请求的输入 Token 可能接近 2 万，这是正常的。

### 可选：设备头绑定

如果管理端给密钥绑定了设备标识，Claude Code 需要额外发送：

```bash
export ANTHROPIC_CUSTOM_HEADERS="X-VeilLink-Device: EXAMPLE-DEVICE-001"
```

多条自定义头使用换行分隔。若密钥未绑定设备，忽略此项。

### 常用验收提示词

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

## ZCode 3.18.2

ZCode 的自定义供应商 GUI 支持完整 Base URL、API Key 和自定义模型 ID，但当前版本没有自定义请求头输入框。

### 配置步骤

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
   - 模型 ID 可填写管理端“上游模型”的值，例如 `your-model-id`；
   - 如果使用其他上游，填写该上游实际可识别的模型 ID；
   - 名称/上下文窗口可按 ZCode 要求填写，或先使用默认值。
10. 启用供应商和模型，点击 **测试模型**。
11. 回到对话界面，在模型选择器中选择刚添加的模型。

### 注意

- 供 ZCode 使用的密钥请 **不要绑定设备标识**，因为 GUI 无法发送 `X-VeilLink-Device`。
- ZCode 可能同时发送 `x-api-key` 和 `Authorization: Bearer`；VeilLink 两者都接受。
- ZCode 不依赖 `/v1/models` 自动发现模型；模型 ID 由你手动填写。
- 管理端“网关配置”的**上游基础地址**只填到 `/v1` 为止（例如 `http://127.0.0.1:3425` 或 `http://127.0.0.1:3425/v1`），不要填 `/v1/messages`、`/v1/chat/completions` 等完整接口路径。ZCode 的 **Base URL** 则只填域名（如 `https://api.example.com`），不要带 `/v1`；ZCode 会自行追加 `/v1` 和 `/messages`。
- 如果上游使用 OpenAI Chat 协议，provider-executed server tools（如 WebSearch）会被跳过，以避免整轮 400；需要这些能力时请把上游换成 Anthropic Messages。

## 客户端模型名与上游模型

管理端“上游模型”有两种工作方式：

1. **已填写**（推荐）：客户端传任何模型名，VeilLink 都改写为该值。适合 Claude Code 固定发送 `claude-sonnet-*`、ZCode 使用自定义模型 ID 的情况。
2. **留空**：仅支持 Anthropic 上游，客户端模型名原样透传。客户端必须发送上游认识的模型名。

如果上游模型填写错误，常见表现为上游返回模型不存在或 400/404；管理端“测试网关”可以帮助定位，但测试前必须填写上游模型（Anthropic 和 OpenAI 协议均适用）。

## 快速自检顺序

1. 公网根路径返回 JSON 404，而不是管理页面。
2. 无密钥请求 `/v1/messages` 返回 401。
3. 有效密钥 `/v1/models` 返回配置的模型。
4. 有效密钥普通 `/v1/messages` 返回 Anthropic JSON。
5. `stream: true` 时能持续收到 `event: message_start`、`content_block_delta`、`message_stop`。
6. Claude Code `/status` 显示公网 Base URL，普通对话成功。
7. Claude Code 工具调用成功。
8. ZCode 测试模型与普通对话成功。
9. 管理端吊销该密钥后，两端新请求均返回 401。
