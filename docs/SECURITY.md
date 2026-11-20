# VeilLink 安全模型与运维边界

## 威胁模型

VeilLink 保护的是：本地网关能力不被未授权公网使用者调用；管理面不进入公网；完整 API Key 不出现在公网响应或日志中；客户端不能绕过模型白名单调用任意上游模型。它不试图抵御已经获得当前 Windows 用户权限的攻击者，也不替代 Cloudflare 边缘的 DDoS 防护。

### 信任边界

1. **公网客户端**：只可信其持有一个有效 API Key。所有请求头、模型名、内容块和路径都不可信。
2. **Cloudflare 边缘/隧道**：终止公网 TLS，并将请求转发到默认的 `127.0.0.1:8788`（由 `VEILLINK_PUBLIC_PORT` 决定）。Cloudflare 账号本身属于你信任的基础设施。
3. **本机管理端**：只有本机浏览器/进程可访问默认的 `127.0.0.1:8787`（由 `VEILLINK_ADMIN_PORT` 决定），且需要管理令牌。
4. **上游网关**：由你配置（本机或 HTTPS 云端），属于可信服务；上游返回的错误信息会被归一化和脱敏后再到公网。上游 API Key 永远不进入客户端响应。
5. **本机文件系统**：安装目录与 `data/` 含可执行代码和密钥材料。通过 Windows ACL 限制到当前用户、SYSTEM、Administrators。

## 资产

- 客户端 API Key（生成后可通过管理端再次查看）。
- 上游 API Key。
- 管理令牌。
- Cloudflare Tunnel 凭据与证书。
- 请求元数据（模型、状态、IP、Token 数等）。
- 上游模型白名单与协议配置。

## 访问控制

### 公网 API

- 独立 HTTP 监听器，默认只绑定 `127.0.0.1:8788`（由 `VEILLINK_PUBLIC_PORT` 决定）；Cloudflare 隧道只指向该端口。
- 只路由当前激活协议对应的端点：
  - Anthropic：`POST /v1/messages`、`POST /v1/messages/count_tokens`、`GET /v1/models`、`GET /v1/models/{model_id}`。
  - OpenAI Responses：`POST /v1/responses`、`POST /v1/responses/compact`、`POST /v1/responses/input_tokens`、`GET /v1/models`、`GET /v1/models/{model_id}`。
  - OpenAI Chat：`POST /v1/chat/completions`、`GET /v1/models`、`GET /v1/models/{model_id}`。
- 其他方法、其他协议的端点、资源型端点（Anthropic batches/files/skills、OpenAI batch/files/evals 等）返回 404/405，不会转发到上游；`OPTIONS` 对当前协议存在的路由返回 204 + `Allow`，不需要 API Key，也不会转发。管理端切换协议时，已经开始但尚未转发的在途请求如果检测到协议已变化，会返回 409，而不是用旧路径/新协议混发。
- OpenAI Responses/Chat 的已存储对象生命周期端点不开放：Responses 的获取/删除/取消/input_items 返回 404；Chat 的 `GET /v1/chat/completions` 因同路径 POST 返回 405，其余返回 404。网关使用单一上游凭据，上游对象 ID 不按 VeilLink 客户端密钥隔离；开放这些端点会造成跨密钥读写和删除。创建、compact、input_tokens 不受影响。
- Responses 的 `previous_response_id` 由网关按 API Key 维护进程内所有权映射（最近 5000 条，超出后淘汰最旧），只允许同一密钥引用；跨密钥、重启后或已淘汰的未知 ID 返回 404。`conversation`、`background: true` 和输入中的 `item_reference`（或带 `id` 但未构成完整可识别输入项的对象（含声明 message/role 却没有 content 的情况））返回 400，避免通过未暴露的 Conversations/后台生命周期/账户级 item 引用绕过所有权边界。
- 引用上游已存储对象的字段返回 400：Responses `prompt` 对象、`file_id`/`file_ids`、`vector_store_ids`、MCP `connector_id`、除 `auto` 外的任何非空 `container`/`container_id` 值，以及 Anthropic `source.type: "file"`、`tool_result` 内的存储引用或内容块中的 `file_id`（工具调用 `tool_use.input` 的参数按 opaque 放行）。OpenAI Code Interpreter 的 `container: "auto"`/`{type:"auto"}` 是新建容器请求，允许透传；工具 `parameters`/`input_schema` 中声明名为 `file_id` 的属性、以及 `file_search.filters` 元数据也不属于运行时存储引用。网关使用单一上游凭据，无法确认这些对象属于当前 VeilLink 密钥；`file_url`、base64 图片/文档和无状态工具参数不受影响。
- 不接受 API Key 查询参数或 Cookie；只接受 `x-api-key` 或 `Authorization: Bearer`。
- 上游基础地址非 loopback 时必须使用 HTTPS；明文 HTTP 仅允许 localhost/回环地址，避免上游密钥在局域网/公网明文传输。
- 公网响应设置 `Content-Security-Policy: default-src 'none'`；非流式成功响应必须为 JSON，SSE 流式成功响应必须为 `text/event-stream`，其他成功内容类型拒绝透传，避免上游返回可执行内容。
- 无效、格式错误、已吊销密钥统一返回通用 401，不区分具体原因。
- 设备绑定密钥缺少或错配 `X-VeilLink-Device` 时返回 403；设备头为可选增强。
- 认证失败按 IP 限流；每密钥独立请求速率和并发限制。
- 认证通过后才读取请求体，且请求体有 100 MB 上限；全局 128 MB 请求体内存预算、全局并发上限（默认 64）和 1152 MB 响应处理预算（流式请求按 48 MB、非流式请求按 96 MB 预留），避免多个大响应同时放大内存。预算是近似准入控制，不是硬内存上限，也未完全覆盖 JSON 对象/字符串副本；有效并发约为流式 24 / 非流式 12（全局预算口径；单密钥还受 `concurrentPerKey` 默认 12 限制）。
- 模型白名单在本地强制执行：messages、count_tokens、responses create/compact、chat create 都要求显式 `model`；`responses/input_tokens` 允许省略 `model`（仅计数，不发起模型推理），提供时仍校验白名单。缺失返回 400，未知或超长模型返回 404/400，均不会到达上游。`/v1/models` 只返回白名单，不暴露上游完整模型目录。
- 上游超时、客户端断开、流式中断都会传播/取消，避免悬挂连接。
- 上游限流/退避头只转发固定白名单（`retry-after`、`x-ratelimit-{limit,remaining,reset}[-requests|-tokens]`、`anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`）；值必须是数字、时长或时间戳，含已知密钥或不合法值会被丢弃。响应中的 `request-id`/`x-request-id` 使用 VeilLink 自己的请求 ID，便于日志关联。
- 只转发协议功能头（`anthropic-version`、`anthropic-beta`、`x-app`、`openai-beta`）；不转发客户端提供的 `anthropic-workspace-id`、`anthropic-user-profile-id`、`openai-organization`、`openai-project`、`idempotency-key` 等账户/幂等上下文头，避免客户端跨租户选择上游工作区或制造跨客户端幂等键碰撞。上游使用其 API Key 的默认上下文。

### 管理端

- 默认只绑定 `127.0.0.1:8787`（由 `VEILLINK_ADMIN_PORT` 决定），不进入 Cloudflare 隧道。
- **Host 白名单**：仅接受 `127.0.0.1:<管理端口>`、`localhost:<管理端口>`、`[::1]:<管理端口>`，阻止 DNS rebinding 和误将隧道指向管理口。
- 管理令牌只保存 scrypt 哈希；持久化明文仅在本机 `data/ADMIN_TOKEN.txt`（ACL 保护），首次启动和交互式 `admin:reset` 还会在终端临时打印。
- 登录成功后签发随机 256 位会话 Cookie：`HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`。
- 登录响应同时签发每个会话独立的随机 CSRF 令牌；除 `/admin/api/login`（必须携带 `X-VeilLink-CSRF: 1`）外，所有 `/admin/api/*` 请求（包括读取状态和日志）都必须携带该会话的 `X-VeilLink-CSRF` 令牌。令牌只保存在服务端会话内存和当前标签页的 `sessionStorage`，不写入 Cookie。
- 每个请求都校验 `Origin`/`Sec-Fetch-Site`；跨站表单无法设置自定义头。
- 管理凭据文件变化（例如 `admin:reset`）会使现有管理会话立即失效。
- 管理登录失败按 IP 限流；成功登录不计入失败预算。管理端只使用回环套接字地址，不信任 `X-Forwarded-For` / `CF-Connecting-IP`。
- CSP `default-src 'none'`、`script-src 'self'`、无内联脚本、无外部 CDN；`X-Frame-Options: DENY`。
- 页面动态数据均通过 `textContent` 写入，避免将密钥名称等用户输入作为 HTML。
- 静态资源使用固定路径映射，不存在目录遍历。
- 管理 API 的完整密钥只在本机响应中出现，带 `Cache-Control: no-store`。
- 配置中的模型白名单、协议、上游地址会出现在管理状态和审计日志中；它们是配置元数据，不是密钥。

## 密钥

### 格式与熵

`sk-` + 56 个字符，字符集为：

```text
0 1 2 3 4 5 6 7 8 9 @ # % & a b c ... z A B C ... Z
```

共 66 个字符，使用 `crypto.randomInt` 无模偏采样。56 字符约 338 bit 熵。

### 存储

- 每个客户端密钥使用 AES-256-GCM 加密保存（随机 IV、认证标签）。
- 认证查找使用 HMAC-SHA256 索引；命中后再解密并进行常量时间比较。
- 主密钥在 `data/master.key`，与密文同目录；安装目录和 data 目录 ACL 收紧。能读取当前 Windows 用户全部文件的人可以解密，这超出本工具防护边界。
- 上游 API Key 也使用同一机制加密，管理端只显示“已配置”，不返回明文。
- 管理令牌使用 scrypt（N=16384, r=8, p=1）加盐存储。
- 密钥落盘权限为尽力 0600；Windows 上真实边界由 ACL 提供。
- 配置 schema 从 v1 升级到 v2 时，`model` 字符串会迁移为单元素 `models` 数组，旧 `openai` 协议会迁移为 `openai-chat`；迁移使用原子写入，不改变已加密的上游密钥。
- 1.2.0 首次启动会把 `keys.json` 从 schema v1 升级到 v2，并清空所有旧客户端密钥记录；旧记录不再出现在列表或认证索引中。`keys.json` 迁移本身不修改 `config.json`、`master.key` 或上游密钥；`config.json` 的常规 schema 迁移/规范化仍按原规则执行。

### 吊销

吊销立即写入磁盘并从有效密钥集合中失效；无需重启服务，管理端点击后不弹确认框。吊销还会断开该密钥已建立的在途请求/流（上游连接随客户端关闭而中止）。已吊销记录默认保留元数据以便审计，可通过管理端查看旧密钥文本，但不能再用于认证；也可在管理端永久删除，删除会从当前 `keys.json` 移除记录和密文，管理端不能恢复，既有备份不受影响。

### 设备头

`X-VeilLink-Device` 由客户端自报，可被伪造，不具备强身份认证能力。它用于减少误用、区分设备、配合可读日志；不能替代独立密钥和及时吊销。设备头对三种协议都生效。ZCode 3.18.2 GUI 不支持自定义头，因此 ZCode 密钥应留空设备字段。

## 模型白名单与协议边界

- 管理端配置 1–5 个上游模型；同一实例所有模型共用一种协议。
- 下游请求的 `model` 必须与白名单完全一致；网关不做模型名改写、别名解析或默认模型回退。
- 未知模型在本地返回 404，不会把任意模型名送给上游。
- `/v1/models` 和 `/v1/models/{id}` 是白名单的只读视图；不代理上游模型目录，不开放模型删除。
- 协议直连：Anthropic → Anthropic、OpenAI Responses → Responses、OpenAI Chat → Chat。不存在 OpenAI ↔ Anthropic 转换路径，因此也不会因转换逻辑引入额外的字段解析/注入面。
- 资源型端点（Anthropic Message Batches/Files/Skills、OpenAI Batch/Files/Evals/Fine-tuning 等）不在 1.2.1 范围内，统一 404；需要时请直连上游。
- OpenAI Responses 的 `store` 默认是 `true`，上游可能保留响应至少 30 天；需要无状态时由客户端显式设置 `false`。VeilLink 不修改该字段。

## 日志与响应

请求日志仅保存：

- 时间、请求 ID、方法、路径、HTTP 状态、耗时。
- 密钥 ID/名称（不含完整密钥）、模型、是否流式、Token 数（如上游提供；Anthropic 输入数包含缓存读取与缓存写入）。
- 客户端 IP（通过 Cloudflare 时为 `CF-Connecting-IP`）、上游状态、错误类型/脱敏摘要。

不保存：

- 请求体、提示词、响应内容、请求头原文。
- 完整客户端密钥或上游密钥。
- Cookie/管理令牌。

所有日志字段经过脱敏函数处理；完整 `sk-` 形式字符串会被替换，敏感命名字段（`apiKey`、`authorization`、`token` 等）整体替换为 `[REDACTED]`。Token 用量字段不会因含 “token” 字样而被误删。请求日志不保存上游错误正文或提示词片段，只保存映射后的错误类型和上游状态码；`error`/`detail` 不会回填上游响应文本。

公网错误响应按协议返回：

- Anthropic：`{"type":"error","error":{"type":"...","message":"..."},"request_id":"vl_..."}`。
- OpenAI：`{"error":{"message":"...","type":"...","param":null,"code":null}}`，并通过 `x-request-id` 返回请求 ID。

上游 400/404/429 消息会脱敏后返回，422 归一化为 400；413 返回通用的请求过大错误；401/403 统一映射为 502，避免误导客户端认为自己的 VeilLink 密钥失效；其他 4xx 默认映射为 502。上游 5xx 使用通用错误文本，不回传上游正文。

所有出站响应都会脱敏配置的上游 API Key 和完整 `sk-` 形式密钥：

- 成功的非流式响应：解析 JSON 后扫描所有文本字段与属性名（含 tool_calls/function_call、tool input、Responses output），检测跨内容块/thinking/signature/工具参数/Responses output 拼接的密钥；检测到可重组密钥时返回 502，不把内容发出去。
- 上游错误响应：扫描完整的解析对象或纯文本正文（包括 `error.message`/`param`/`code` 和额外字段）；检测到可重组密钥时替换为通用错误，并保留映射后的上游状态码（例如 400）。OpenAI 错误响应只向外返回归一化的 `error.message/type/param/code`，不透传上游额外字段；Responses 流式 `error` 事件额外保留协议字段 `sequence_number`。
- 流式响应：按字段滚动缓冲，并维护跨字段的文本片段集合；任意由至少 3 字符子串或完整 1–2 字符字段组成的组合可还原完整密钥时（包括被无关文本分隔、三段拆分或事件名/数据拆分），会立即终止流并返回通用错误，不把完整密钥发出。SSE 事件名本身也会先脱敏完整上游密钥；协议保留的 `message` 事件名不会写入输出 `event:` 行，因此不参与该检查。非流式响应会对所有文本字段与属性名做同样的片段组合检查。`encrypted_content`、`b64_json` 以及音频/图片/视频的 base64 `data`/`result` 等不透明载荷不参与片段累积，避免随机密文触发误报；这些字段仍会做完整密钥的逐字替换。Anthropic thinking `signature` 仍参与跨字段片段检查。
  - Anthropic：文本增量跨内容块滚动缓冲，thinking 在单个 thinking 块内、工具参数在单个工具块内、signature 在单个 thinking 块内做跨事件聚合/脱敏；密钥被拆分到同一块内的多个同类增量时也不会完整发出。
  - 边界：当前实现把任意对象中字符串型 `data`/`result` 都按不透明载荷处理，只替换精确配置的上游 secret，不套用通用 `sk-` 正则；这是为避免破坏媒体 base64/密文。上游若在这些字段回显其他非当前配置的 `sk-` 形式 token，会原样透传；上游属于信任边界内的服务。
  - OpenAI Responses：`response.output_text.delta`、`response.function_call_arguments.delta`、reasoning/refusal 等 delta 字段按事件类型和 item 位置分别做滚动缓冲；终止事件前 flush 剩余文本。
  - OpenAI Chat：`delta.content`、`delta.reasoning_content`、`delta.refusal`、`tool_calls[].function.arguments`、legacy `function_call.arguments` 分别做滚动缓冲；`[DONE]` 前 flush。
- 上游流在超时、断连、意外结束或缺少协议终止信号（Anthropic `message_stop`、Responses 终止事件、Chat `[DONE]`）时，会转换为对应协议的 `error` 事件/数据帧；不会把截断内容伪装成正常完成。
- Chat 上游若在 `[DONE]` 前中断，不会补发 `[DONE]`；Responses 上游若缺少终止事件，不会伪造 `response.completed`。

## 文件与进程

- 安装目录与 `data/` 的 ACL 助手会先接管所有权、移除继承、删除白名单外的 Allow ACE，并删除所有显式 Deny ACE（例如从备份恢复的 Everyone 权限），再只授予当前用户 SID、SYSTEM 和 Administrators；不会先把目录重置为父目录的宽权限。最终逐项验证 Allow/Deny ACE 和 Owner，任何白名单外的 ACE 或所有者默认都会导致启动失败（除非设置 `VEILLINK_ALLOW_INSECURE_ACL=1`）。服务启动和 `scripts/start.ps1` 都会执行该检查；也可手动运行 `pwsh scripts/setup-acl.ps1`。
- 云隧道启动前会校验 cloudflared 的固定 SHA-256；`tunnel-setup.ps1` 也会校验，防止被替换的二进制建立出站隧道。
- 如果 ACL 收紧失败，Windows 上服务默认拒绝启动，避免密钥目录停留在继承权限下。仅在明确接受风险且使用无法设置 ACL 的文件系统时，才可在启动前设置 `VEILLINK_ALLOW_INSECURE_ACL=1` 跳过该保护；`start.ps1` 和 `npm start` 都会识别该开关。
- Cloudflare 证书/隧道凭据放在 `data/tunnel/`，同样受 ACL 保护。
- `scripts/start.ps1` 启动的后台进程日志在 `data/logs/`；首次管理令牌仅在交互式终端打印，后台模式从文件读取。
- 桌面快捷方式、托盘进程和 `launcher.ps1` 都以当前 Windows 用户运行；托盘只负责启动/停止本机进程和打开管理页，不改变公网鉴权边界。停止操作要求确认。
- `data/veillink.lock` 是单实例锁（PID + 随机 token）；运行中的实例拒绝第二个实例使用同一数据目录。锁文件为空/不可读时服务 fail-closed，需人工确认无活实例后删除；不要在服务运行时删除锁文件。
- 不要将 `data/`、`Temp/`、`bin/cloudflared.exe` 提交到公开仓库。

## Cloudflare 相关

- 命名隧道仅出站连接，不需要公网 IP 或端口映射。
- 隧道配置只含一个 hostname ingress：`hostname → http://127.0.0.1:<公网源站端口>`；兜底 404。`start.ps1` 会做结构校验（单一 ingress/hostname、目标 service、404 兜底，拒绝 quoted 映射键、`path` 规则、flow 映射/anchors/aliases/merge keys、显式 `?` 键、反斜杠转义/escape sequences、`originRequest`/`httpHostHeader`/debug 日志），并运行 `cloudflared tunnel ingress validate` 与多路径 `ingress rule` 断言；最终还要求配置与 `tunnel-setup.ps1` 生成的标准结构完全匹配，手工加入的额外 YAML 结构会被拒绝。隧道进程以 `--protocol http2 --metrics 127.0.0.1:<metrics-port> --loglevel info --no-autoupdate` 启动；HTTP/2 只改变传输方式，不改变 ingress。若网络无法建立 HTTP/2，必须同时从 `start.ps1` 和 `watchdog.ps1` 的 cloudflared 启动参数中移除 `--protocol http2` 并重启隧道，否则 watchdog 重启时会重新加回该参数。
- 管理端端口（默认 `8787`，由 `VEILLINK_ADMIN_PORT` 决定）不应出现在任何隧道 ingress 中。
- 隧道与 Node 服务通过 watchdog 绑定：启动时验证 watchdog 进程身份和存活；`start.ps1` 等待 cloudflared `/ready` 至少一条边缘连接（最多 30 秒），失败返回非零；watchdog 持续检查 cloudflared 进程与 `/ready`，连续失败后按退避重启，且每次重启前用 `scripts/tunnel-validate.ps1` 重新校验固定哈希、canonical ingress、目标 service 和路由规则；服务器退出/崩溃时 watchdog 按当前隧道配置停止 cloudflared；`stop.ps1` 先停隧道和服务器，清理失败会返回非零并提示，托盘在异常失去管理端口时也会主动调用 `stop.ps1 -Force`。
- 一个实例只激活一种协议；多协议并行时每个实例使用独立数据目录、端口和隧道/主机名。所有隧道都只能指向各自的公网源站端口，绝不能指向管理端口。
- Cloudflare 账号应启用强密码/2FA；隧道证书和凭据等同机器身份。
- 建议 Cloudflare SSL/TLS 使用 Full (strict) 或 Automatic；不要使用 Flexible。启用 Always Use HTTPS。
- 免费计划最大请求体约 100 MB；这是视频等大文件的实际上限。

## 已知限制

- 单管理员、单上游、单激活协议模型；没有公网管理、用户注册、计费、配额。
- 同一实例最多 5 个上游模型；多协议并行需要多个实例。
- Responses `previous_response_id` 所有权映射仅保存在进程内存（最近 5000 条），重启后或超出映射的旧 ID 返回 404；`conversation`、`background: true` 与输入中的 `item_reference` 不开放。`reasoning` 输入可携带内联 `summary`/`content`/`encrypted_content`，只有裸 `id` 的 reasoning/compaction 返回 400；`reasoning.id` 原样透传。`encrypted_content`/`compaction` 和显式 reasoning `id` 是上游账户级不透明数据，共享上游 Key 时不提供严格的跨 VeilLink Key 隔离；需要严格隔离请使用独立上游账号。
- 为强制模型白名单，Responses 创建/压缩请求必须显式带 `model`；`input_tokens` 可省略 `model`，提供时校验白名单。不支持仅靠 `prompt`/`conversation` 推导模型。
- 本机恶意进程或已登录用户可读取数据目录、调用管理 API，或篡改二进制。
- 设备头不是强认证。
- 管理会话是高度信任角色：管理员可以修改上游 `baseUrl` 并触发“测试上游”，从而让已保存的上游密钥随请求头发送到其指定的 HTTPS 主机。若需要限制“管理员可配置但不可导出上游密钥”，应对 `baseUrl` 变更或测试目标增加二次确认/白名单。
- 标准 Anthropic Messages 协议无原生视频内容块；视频依赖上游/客户端扩展。
- 服务进程不是 Windows 系统服务；需要持久运行时可使用计划任务或进程管理器。
- 管理 Cookie 是主机级而不是端口级；已登录管理端时不要访问其他不可信的 `127.0.0.1` 端口服务。管理 API 还要求每个会话独立的 CSRF 令牌，可阻止仅窃取 Cookie 的其他本机服务直接重放读写请求，但本机恶意进程仍属于信任边界外。
- 公网监听器仅在 TCP 对端为回环地址（Cloudflare 隧道或本机代理）时信任 `CF-Connecting-IP` 用于限流和日志；不信任客户端可伪造的 `X-Forwarded-For`。缺少 `CF-Connecting-IP` 时按回环地址计数，不会退回到可伪造的 XFF。非回环直连使用真实套接字地址。不要把公网源站端口直接映射到公网；若通过本地端口转发暴露，转发器必须提供可信的真实客户端地址头，并剥离客户端自带的 `CF-Connecting-IP`。
- 管理登录失败按真实回环地址限流；本机进程可以故意失败登录造成短时锁定（可用性影响，不是认证绕过）。
- 100 MB 请求体在进程内缓冲并 JSON 解析；已授权客户端仍可能造成内存/事件循环压力。需要处理超大视频时请评估上游和机器内存。
- 上游响应有读写空闲超时，但没有独立的“总时长”硬截止；极慢的上游可以占用一个并发槽直到空闲超时。
- 如果 `master.key` 丢失且未配置上游密钥，服务可能生成新主密钥，导致已保存的客户端密钥无法认证；启动日志和管理页会提示无法解密的密钥数量，请恢复备份的 `master.key` 或重新生成客户端密钥。若已配置上游密钥，启动会失败；先停止服务，运行 `npm run upstream:reset` 清除已保存的上游密钥密文（会无条件清除，即使仍可解密），再重新输入。
- `config.json` / `keys.json` / `admin.json` 的元数据没有额外的 HMAC 签名；能写入数据目录的本机进程属于信任边界外。
- 极端情况下，上游若被攻陷并故意把密钥拆分到多个不同类型的字段（例如 thinking 与 text、文本与工具参数、或 thinking 与 signature 之间）、跨多个 thinking 块，或跨多个工具调用块，重组仍属于上游信任边界内的残余风险；文本块/文本增量已做跨块脱敏，thinking、工具参数和 signature 仅在同一内容块内做跨事件脱敏。OpenAI 流式响应的同类风险按 delta 类型和 item 位置分别缓冲，跨不同类型字段的重组仍属于残余风险。
- 跨字段片段检测以至少 3 字符的子串和完整的 1–2 字符字段为单位；被攻陷的上游若把 1–2 字符片段嵌入更长的无关文本，仍可能绕过片段组合检查。要完全消除该残余风险需要缓冲整条流或限制上游输出，不在本项目边界内。
- 上游 API Key 必须为 4–8192 字符且不含控制字符；更短的密钥在配置阶段即被拒绝，不会进入脱敏逻辑。已有 `config.json` 中不符合该条件的密钥也会在加载时 fail-closed，需停止服务并运行 `npm run upstream:reset` 后重新填写。正常供应商密钥远长于该下限。
- `cloudflared` 与 Node 服务默认以同一 Windows 用户运行；需要更强隔离时，应使用单独的低权限服务账户并同步调整 ACL/隧道凭据权限。
- Cloudflare 边缘终止公网 TLS，理论上可见客户端 API Key 和提示词；这是使用 Cloudflare Tunnel 的信任边界。
- Cloudflare 无 SLA、边缘网络质量、上游可用性不由本项目保证。

## 事件处置

1. 立即在管理端吊销泄露的 API Key。
2. 若上游密钥可能泄露：更换上游密钥并在“网关配置”中更新。
3. 若管理令牌可能泄露：先停止服务，再运行 `npm run admin:reset`（脚本会拒绝在服务仍监听时执行）。
4. 若隧道凭据泄露：在 Cloudflare 删除/轮换隧道并重新安装 cloudflared。
5. 检查 `data/logs/access.log` 的请求元数据；必要时清空。
6. 停止服务：右键托盘图标 → **停止 VeilLink…** 并确认，或运行 `pwsh "C:\VeilLink\scripts\stop.ps1"`（会弹出确认框；自动化加 `-Force`）。
