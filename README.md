# VeilLink

VeilLink 是一个运行在 Windows 本机的轻量网关分发器：接入你指定的本地模型网关，以 Anthropic Messages 兼容 API 通过 HTTPS 安全提供给公网客户端，并用独立 API Key 控制每个使用者。

当前实现以“单网关、多 API Key、本机管理、公网只开鉴权 API”为边界。项目零运行时 npm 依赖，仅使用 Node.js 内置模块。

## 特性

- 上游支持 **Anthropic Messages** 原生透传，以及 **OpenAI Chat Completions** → Anthropic 的流式/非流式翻译。
- 客户端兼容 Claude Code、ZCode 等使用 Anthropic `/v1/messages` 的工具。
- 单上游、多密钥；密钥可生成、查看、复制、独立吊销，立即生效。
- 公网管理面为零：公网监听器只提供 `/v1/messages`、`/v1/messages/count_tokens`、`/v1/models`。
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
Claude Code / ZCode / API 客户端
        │ HTTPS
        ▼
Cloudflare 边缘（Universal SSL）
        │ 加密隧道（cloudflared 出站）
        ▼
127.0.0.1:8788  公网 API 监听器（只有 /v1/*）
        │ 鉴权、限流、模型映射、协议翻译
        ▼
你填写的本地网关（Anthropic 或 OpenAI 兼容）

浏览器 ──► 127.0.0.1:8787  管理监听器（仅本机，不接隧道）
```

管理端和公网 API 使用两个独立的 HTTP 监听器。Cloudflare 隧道只指向公网源站端口（默认 `8788`）；因此即使误配置了 Host，管理端也不会出现在公网。

## 目录

```text
VeilLink/
├─ src/                 Node.js 服务端
│  ├─ upstream/         Anthropic 透传、OpenAI 翻译、SSE、上游 HTTP
│  └─ ...
├─ web/                 仅本机管理前端
├─ assets/              应用图标（PNG / ICO）
├─ scripts/             启动器、快捷方式、启动/停止、云隧道、管理令牌重置、ACL
├─ test/                假上游、单元测试、集成测试
├─ bin/                 cloudflared.exe（含来源与校验说明）
├─ data/                运行时密钥、配置、日志、隧道凭据（自动创建，禁止公开）
├─ docs/                部署、安全、客户端、运维文档
└─ Temp/                临时文件，验收后清理
```

## 快速开始

要求：Windows 10/11、Node.js 22+、PowerShell 7（`pwsh`）。本机已满足。

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
   - **基础地址**：例如 `http://127.0.0.1:3425` 或 `http://127.0.0.1:11434`。只填到 `/v1` 为止，末尾不要带 `/v1/messages`。
   - **上游协议**：Anthropic Messages 或 OpenAI Chat。
   - **上游鉴权**：自动、`x-api-key`、Bearer 或“无鉴权”。
   - **上游模型**：填写后，所有客户端模型名都会改写为该值。OpenAI 协议必填。
   - **上游 API Key**：可选；留空会保留原值，勾选“清除”才会删除。
   - **公网 API 地址**：例如 `https://api.example.com`，仅用于展示和客户端配置，必须是 HTTPS。
4. 点击“保存配置”，需要时可点击“测试网关”（会实际发送一次最多 1 token 的请求；测试前必须填写上游模型，Anthropic 和 OpenAI 均适用）。
5. 在“API 密钥”中生成密钥。完整密钥只在本机管理页显示；请通过可信渠道发送。

### 密钥与设备头

- 每个密钥独立、可立即吊销；吊销后任何新请求都返回 401。
- 生成时可选填设备标识。绑定后，客户端必须发送：

```http
X-VeilLink-Device: EXAMPLE-DEVICE-001
```

- 设备头是增强项，不是强身份认证；真正的安全边界是独立密钥、熵、限流和撤销。
- ZCode 3.18.2 的自定义供应商 GUI 目前不能设置自定义请求头，因此供 ZCode 使用的密钥请不要绑定设备。
- Claude Code 可通过 `ANTHROPIC_CUSTOM_HEADERS` 发送该头（换行分隔多条）：

```bash
export ANTHROPIC_CUSTOM_HEADERS="X-VeilLink-Device: EXAMPLE-DEVICE-001"
```

## 客户端接入

完整的图形界面步骤见 [docs/CLIENTS.md](docs/CLIENTS.md)。

### Claude Code

通过 CCswitch / Magpie 的图形界面选择 Anthropic 兼容供应商，填入：

- Base URL：`https://你的域名`（不要加 `/v1/messages`）
- API Key：`sk-...`

或使用环境变量直接验证：

```bash
export ANTHROPIC_BASE_URL="https://你的域名"
export ANTHROPIC_API_KEY="sk-..."
claude
```

`ANTHROPIC_AUTH_TOKEN` 也可使用（服务端同时接受 `x-api-key` 与 `Authorization: Bearer`）。若本机 `~/.claude/settings.json` 已有网关配置，请注意设置文件可能覆盖进程环境；验收时以界面显示或实际请求日志为准。

### ZCode

在 ZCode 3.18.2 中：

1. **设置 → 基础设置 → 模型设置 → 添加供应商 → 其他 → 创建自定义供应商**。
2. **API 格式**选择 `Anthropic Messages (/v1/messages)`。
3. **Base URL** 填 `https://你的域名`（不要填完整接口路径）。
4. 填入 API Key。
5. 在模型列表添加一个模型 ID；可填写上游模型名，例如 `your-model-id`。管理端配置的“上游模型”会将请求统一改写。
6. 启用供应商并点击测试模型。

## API

公网只开放：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/messages` | Anthropic Messages，支持 `stream: true` |
| POST | `/v1/messages/count_tokens` | Anthropic 上游优先透传；上游 404/405 或响应无效时返回估算值；OpenAI 模式返回估算值 |
| GET | `/v1/models` | 返回配置的上游模型或上游模型列表 |

鉴权头二选一（同时发送相同值也接受）：

```http
x-api-key: sk-...
```

或：

```http
Authorization: Bearer sk-...
```

调用示例：

```bash
curl -sS https://你的域名/v1/messages \
  -H "x-api-key: $VEILLINK_KEY" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  --data '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 128,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

错误响应为 Anthropic 风格：

```json
{"type":"error","error":{"type":"authentication_error","message":"Invalid API key."},"request_id":"vl_..."}
```

常见状态码：400 请求错误、401 无效/吊销密钥、403 设备不匹配、404 路径不存在、413 请求过大、429 限流、502 上游不可达或上游错误、503 尚未配置网关。

### 全模态说明

- Anthropic 协议下，请求体中的内容块会原样透传，包括文本、图像、文档以及上游支持的扩展内容块。
- OpenAI 翻译模式支持文本、图像、内联 base64 PDF 文档块，并把 `video` 块映射为事实扩展 `video_url`。
- OpenAI 翻译模式会跳过上游不可执行的 provider-executed server tools（例如 Claude Code WebSearch 的 `web_search_20250305`），避免整轮请求 400；这类工具能力需使用 Anthropic 上游。远端文档 URL 在 OpenAI 模式下会返回明确的 400，请改用 Anthropic 上游或内联 base64。
- 上游流在超时、断连、缺少 `message_stop` 或意外结束时中断会转换成 Anthropic `error` 事件；不会把截断内容伪装成正常完成。
- **标准 Anthropic Messages API 本身没有原生 `video` 内容块**。VeilLink 不丢弃视频块，但能否端到端识别视频，取决于客户端是否发送该扩展块以及上游是否支持。Claude Code / ZCode 的标准界面主要使用文本、图像和文档。
- Cloudflare 免费计划请求体上限约 100 MB，VeilLink 默认同样限制为 100 MB。

## 安全设计

详见 [docs/SECURITY.md](docs/SECURITY.md)。

- 管理端只绑定回环地址，并校验 `Host`、`Origin`、每个会话独立的 CSRF 令牌、管理令牌和 SameSite=Strict 会话 Cookie；管理凭据重置后旧会话立即失效。
- 公网监听器完全不包含管理路由、静态文件或管理 API。
- API Key 不写入 URL；日志、错误响应、管理状态均不包含完整客户端密钥。
- 密钥和上游密钥 AES-GCM 加密保存；管理令牌只保存 scrypt 哈希；安装目录与 data 目录的 ACL 会接管所有者、删除白名单外 Allow ACE 和所有显式 Deny ACE，并逐项验证。
- 认证失败限流、每密钥速率/并发限制、请求体上限、上游超时与中断传播；流式响应跨块脱敏上游密钥。
- Cloudflare 命名隧道时，本机不开放入站端口；隧道与 Node 服务通过 watchdog 绑定，服务器退出时自动停止隧道。

## Cloudflare 部署

示例占位：本文使用 `example.com` 和 `api.example.com`。部署时请替换为你的实际域名；仓库不包含真实域名、账号或凭据。以下步骤用于从零部署或迁移。

固定公网域名需要你本人完成注册与付款。步骤见 [docs/DEPLOY-CLOUDFLARE.md](docs/DEPLOY-CLOUDFLARE.md)。核心步骤：

1. 在 Porkbun（或你选择的注册商）注册域名并加入 Cloudflare（免费套餐）。
2. 将域名 NS 指向 Cloudflare，等待状态 Active。
3. 在浏览器完成 `cloudflared tunnel login` 授权。
4. 运行：

```powershell
cd "C:\VeilLink"
pwsh -NoProfile -File scripts\tunnel-setup.ps1 -Hostname api.example.com
```

5. 管理端“公网 API 地址”填入 `https://api.example.com`，再双击桌面 VeilLink 快捷方式（或运行 `scripts\start.ps1`）同时启动服务和命名隧道。

命名隧道只指向当前公网源站端口（默认 `http://127.0.0.1:8788`）。管理端端口（默认 `8787`）不进入隧道配置。

## 测试

```bash
npm test
```

测试覆盖：

- API Key 格式、加密持久化、查看、吊销、设备绑定。
- 管理端 Host/Origin/CSRF/会话校验。
- 公网管理面隔离、鉴权、401/403/413/429 路径。
- Anthropic 非流式与 SSE 流式透传、模型映射、错误归一化。
- OpenAI 非流式/流式翻译、工具调用、图像、Token 用量。
- 日志脱敏与密钥不落盘。
- 上游密钥含 JSON 特殊字符时的非流式、`/v1/models` 和管理端测试预览脱敏。
- thinking / signature 流式增量脱敏，以及 `message_delta` 之后的 SSE 事件顺序。
- 假上游可在 `test/fake-upstream.js` 中扩展。

实际链路验收还应包含：Cloudflare 公网 URL 下用有效密钥调用 Claude Code、ZCode；吊销后 401；公网访问管理页/管理 API 为 404。

## 运维

- 启动：桌面 VeilLink 快捷方式（推荐）或 `scripts\start.ps1`
- 停止：右键托盘图标 → **停止 VeilLink…**；命令行使用 `scripts\stop.ps1`（加 `-Force` 跳过确认）
- 重置管理令牌：先停止服务，再运行 `npm run admin:reset`；脚本会拒绝在管理端口仍监听时重置，并让旧管理会话失效。令牌始终写入 `data\ADMIN_TOKEN.txt`；交互式终端还会打印。
- 上游密钥无法解密：先停止服务，运行 `npm run upstream:reset` 清除无法解密的 `apiKeyEnc`，再启动服务并在管理端重新输入上游密钥。该命令同样拒绝在管理端口仍监听时执行。
- 数据备份：完整备份 `data\`；`master.key` 丢失会导致已存的 API Key 和上游密钥无法解密。客户端密钥无法解密时，管理页会提示，需要重新生成密钥或恢复备份的 `master.key`。
- 请求体默认上限 100 MB，同时有 128 MB 的全局并发请求体预算；超出时返回 413/429，避免内存放大。
- 日志：`data\logs\access.log`（自动轮转）；管理页最多显示最近 100 条请求记录。
- 端口覆盖（可选）：`VEILLINK_ADMIN_PORT`、`VEILLINK_PUBLIC_PORT`、`VEILLINK_DATA_DIR`。`VEILLINK_DATA_DIR` 必须是专用目录，不能是盘符根目录、项目根目录、`%SystemRoot%` 及其子目录，或用户目录/Program Files/AppData/ProgramData 的根目录。`tunnel-setup.ps1` 会把当前的 `VEILLINK_PUBLIC_PORT`（默认 8788）写入隧道配置；`start.ps1` 会校验隧道 service 与当前端口一致，并要求配置保持 `tunnel-setup.ps1` 生成的标准结构。修改端口后建议重新运行 `tunnel-setup.ps1`；手工编辑 `data\tunnel\config.yml` 时不要改变结构，否则隧道会被拒绝启动。**使用自定义数据目录或端口时，`stop.ps1`、`npm run admin:reset` 和 `npm run upstream:reset` 必须在同一终端设置相同的 `VEILLINK_DATA_DIR` / `VEILLINK_ADMIN_PORT`，否则会操作默认 `data`/8787 实例。**

## 已知边界

- 本项目是单管理员、单上游设计，不提供多租户、配额计费、用户注册或 Web 管理公网暴露。
- 上游响应速度、模型能力、工具支持和多模态能力由你的本地网关决定。
- 设备头可被伪造，只作为增强，不作为强设备认证。
- Cloudflare 免费套餐的无 SLA 特性、中国大陆到 Cloudflare 边缘的网络质量可能影响体验；命名隧道比临时隧道稳定。
- 公网 API 必须通过 HTTPS 使用；不要将管理端口或公网源站端口（默认 8787 / 8788）直接映射到公网。

## License

MIT License. See [LICENSE](LICENSE).
