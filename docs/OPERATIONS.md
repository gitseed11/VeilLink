# 运维手册

以下命令默认在项目根目录 `C:\VeilLink` 执行；如果当前目录不同，请先 `cd` 到该目录。

## 启动与停止

### 桌面快捷方式（推荐）

双击桌面 **VeilLink** 快捷方式：

- 服务未运行时会后台启动，并用 Edge 应用窗口打开本机管理页；
- 关闭管理页窗口不会停止服务；
- 托盘保留 VeilLink 图标，双击可重新打开管理页；
- 停止服务：右键托盘图标 → **停止 VeilLink…** → 在确认框中选择“是”。确认框默认“否”，停止会同时关闭 Cloudflare 隧道。

快捷方式丢失时重新创建：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\create-shortcuts.ps1
```

如果从命令行停止服务，托盘图标会在检测到管理端口关闭后自动退出。

快捷方式/托盘只管理由快捷方式或 `scripts\start.ps1` 启动的实例（命令行带 `--veillink-data-dir` 标记）。如果正在用 `npm start` 前台运行，请先停止该实例，否则快捷方式会提示管理端口被其他程序占用。

### 命令行

前台（可看到实时日志，窗口关闭即停止）：

```powershell
cd "C:\VeilLink"
npm start
```

后台：

```powershell
pwsh -NoProfile -File scripts\start.ps1
```

仅本机运行（不启动公网隧道）：

```powershell
pwsh -NoProfile -File scripts\start.ps1 -NoTunnel
```

该模式会先停止已有托管隧道和隧道 watchdog，再写入 `tunnel-state.json` 的 `mode=disabled`；如果仍有 cloudflared/watchdog 残留而无法停止，会写 `mode=error` 并返回非零。它不会停止本地 Node 服务；主要用于本机维护，日常快捷方式不会传入此开关。`launcher.ps1` 的 `-NoOpen`/`-NoTray`/`-Quiet` 仅供内部测试/自动化，普通运维不需要。

`start.ps1` 会：

- 收紧并验证安装目录/数据目录 ACL，并校验 `node` 与公网监听器确实由本次启动的进程持有
- 按数据目录获取启动互斥量，避免快速多次双击并发运行多个 `start.ps1`；服务端自身也会在数据目录持有单实例锁
- 启动 `node src/server.js`，PID 写入 `data\veillink.pid`；命令行带 `--veillink-data-dir=<数据目录>`，避免误匹配其他实例
- 如果 `data\tunnel\config.yml` 存在且 `bin\cloudflared.exe` 可用，先结构校验隧道配置并运行 `cloudflared tunnel ingress validate` / 多路径 `ingress rule`，再启动命名隧道（`--protocol http2 --metrics 127.0.0.1:<metrics-port> --loglevel info --no-autoupdate`），PID 写入 `data\cloudflared.pid`。启动后轮询 `/ready`（最多 30 秒），至少一条边缘连接就绪才算成功；失败会停止本次启动的 cloudflared 并返回非零，管理页和托盘显示“公网入口不可用”
- 校验失败时会停止本实例已有的托管隧道，避免无效配置继续暴露旧入口；如果是本次新启动的 cloudflared 在就绪前退出，只停止该子进程，不会连带杀掉其他健康隧道
- 启动 `watchdog.ps1`，验证其进程身份和存活；watchdog 每 5 秒检查 cloudflared 进程与 `/ready`，连续 3 次失败后按退避重启（最多 5 次）；每次重启前调用 `scripts\tunnel-validate.ps1` 重新校验 cloudflared 固定哈希、canonical ingress、目标 service 和路由规则，校验失败不会启动未经验证的隧道。服务器退出/崩溃时自动停止隧道；watchdog 无法启动或立即退出时会停止隧道，避免公网继续指向空闲端口
- 将日志写入 `data\logs\server.out.log`、`server.err.log`、`cloudflared.out.log`、`cloudflared.err.log`、`watchdog.log`、`watchdog.out.log`、`watchdog.err.log`；启动前会轮转已有日志，保留最近 5 份历史

停止（会弹出确认框）：

```powershell
pwsh -NoProfile -File scripts\stop.ps1
```

自动化脚本可跳过确认：

```powershell
pwsh -NoProfile -File scripts\stop.ps1 -Force
```

`stop.ps1` 会先停止隧道，再停止服务器和 watchdog；PID 文件丢失或过期时会按可执行文件路径和当前实例的 `--veillink-data-dir` / 隧道配置路径精确扫描，避免误杀其他实例。清理后若仍有本实例的 node/cloudflared/watchdog 进程、8787/8788 仍被监听，或数据目录锁仍无法安全清除，脚本会返回非零；托盘会提示失败并保留图标，便于重试。锁清理只在确认服务器进程已停止后执行，并会二次校验 PID/token，避免删除并发启动的新锁。若崩溃后旧 PID 被系统复用给无关进程，stop/clean 会按 fail-closed 拒绝继续而不是误杀；确认锁/状态文件属于已退出的旧实例后人工删除，再重试。Windows 上 stale 锁回收由操作系统命名管道互斥，进程退出/崩溃后自动释放；非 Windows 使用 fail-closed 文件 gate，崩溃遗留的 `data\veillink.lock.reclaim` 需人工确认无实例后删除。命名管道名称可被同机进程抢占并导致约 10–13 秒后启动失败，属本地可用性边界；正常启动（无 stale 锁）不受影响。

## 管理令牌

- 初始令牌：`data\ADMIN_TOKEN.txt`
- 重置前先停止服务；脚本会检查管理端口，发现服务仍在监听时拒绝重置：

  ```powershell
  pwsh -NoProfile -File scripts\stop.ps1
  npm run admin:reset
  ```

  这会把新令牌始终写入 `data\ADMIN_TOKEN.txt` 并替换哈希；交互式终端还会打印，输出被重定向时只提示读取文件。凭据变化后，旧管理会话会立即失效。
- 若服务端控制台警告令牌文件缺失/不匹配，或登录后的管理页弹出“令牌文件缺失或与凭据不一致”，通常说明文件被手动删除/替换或未完整重置；运行上面的重置命令即可。
- 管理令牌只允许本机使用。不会通过公网 API 或页面泄露。

### 上游密钥无法解密

如果启动时提示 `The stored upstream API key cannot be decrypted`：

```powershell
pwsh -NoProfile -File scripts\stop.ps1
npm run upstream:reset
pwsh -NoProfile -File scripts\start.ps1
```

`upstream:reset` 会无条件清除 `data\config.json` 中已保存的上游密钥密文（即使该密钥当前仍可解密），保留上游地址、协议和模型白名单；之后在管理端重新输入上游 API Key。若同时有客户端密钥返回 401，管理页会提示无法解密的密钥数量；需要重新生成这些客户端密钥，或恢复与 `keys.json` 配套的 `master.key` 备份。

## 数据与备份

需要备份的目录：`data\`

> 1.2.x 使用配置 schema v2（`models` 数组、`openai-responses` / `openai-chat` 协议名）。从 1.0.0 升级时，启动会自动把旧的 `model` 字符串迁移为单元素 `models`，把旧 `openai` 迁移为 `openai-chat`，并原子重写 `config.json`。如果旧配置已填写上游地址但 `model` 为空，迁移后模型白名单仍为空，公网推理会返回 503；请在管理端添加至少一个模型。运行时会规范化超限/重复模型、无效地址和越界限制，并把规范化结果写回 v2 配置。已有配置中的有效值不会被 1.2.x 的默认值覆盖；加载时仍会做常规规范化（例如去掉 URL 末尾斜杠、去除模型名首尾空白）并写回 `config.json`；无效或越界值按规范化规则处理。
>
> 1.1.x 的 `data\keys.json` 在首次 1.2.0 启动时会升级为 schema v2，并自动清空所有旧客户端密钥记录。旧密钥无法通过认证，需要重新生成并替换到客户端。升级前建议完整备份 `data\`；用 1.1.x 的 `keys.json` 恢复到 1.2.0 后，下次启动会再次清空。
>
> 回退到 1.1.x 时，1.1.x 无法读取 schema v2 的 `keys.json`，会拒绝启动；需要先删除或替换该文件，且 1.2.0 生成的 56 位密钥无法在 1.1.x 使用。

关键文件：

| 文件 | 内容 |
|---|---|
| `data\master.key` | AES 主密钥；丢失后无法解密已保存的密钥 |
| `data\config.json` | 上游配置（上游密钥为密文） |
| `data\keys.json` | 客户端密钥记录（密文与 HMAC 索引） |
| `data\admin.json` | 管理令牌 scrypt 哈希 |
| `data\ADMIN_TOKEN.txt` | 管理令牌明文，权限收紧 |
| `data\tunnel\` | Cloudflare 授权证书、隧道凭据、config.yml |
| `data\logs\` | 请求元数据日志，自动轮转 |

备份建议：

- 停止服务后复制整个 `data\` 到加密磁盘或密码管理器附件。
- 不要通过微信、网盘公开分享 `data\`。
- 恢复时保持相同 Windows 用户和 ACL；`master.key` 与 `keys.json` 必须配套。

## 密钥吊销与删除

- 吊销无需确认，点击后立即生效；旧密钥马上失效，该密钥已建立的在途请求/流会被断开，列表标记“已吊销”。
- “删除”只出现在已吊销的行上，点击需要确认。删除会从当前 `keys.json` 移除该记录和密钥密文，管理端无法恢复；既有 `data\` 备份不受影响。历史请求日志仍保留当时的密钥名称。
- 删除不影响有效密钥数量上限；已吊销记录本来就不占名额。

## 端口

默认：

- 管理端：`127.0.0.1:8787`
- 公网 API 源站：`127.0.0.1:8788`
- Cloudflare 命名隧道默认指向 `8788`（由 `VEILLINK_PUBLIC_PORT` 决定）

可选环境变量：

```powershell
$env:VEILLINK_ADMIN_PORT = "8787"
$env:VEILLINK_PUBLIC_PORT = "8788"
$env:VEILLINK_DATA_DIR = "C:\VeilLink\data"
npm start
```

`VEILLINK_DATA_DIR` 必须是专用目录，不能是盘符根目录、项目根目录、`%SystemRoot%` 及其子目录，或用户目录/Program Files/AppData/ProgramData 的根目录；`start.ps1` 与 `src/paths.js` 都会拒绝这些路径。`start.ps1` 会读取 `VEILLINK_ADMIN_PORT` / `VEILLINK_PUBLIC_PORT` 用于监听、健康检查和显示。`tunnel-setup.ps1` 会把当前的 `VEILLINK_PUBLIC_PORT`（默认 8788）写入 `data\tunnel\config.yml`；`start.ps1` 启动隧道前会校验该 service 与当前端口完全一致，并要求配置保持 `tunnel-setup.ps1` 生成的标准结构。修改公网源站端口后，建议重新运行 `tunnel-setup.ps1`；手工编辑配置时必须保持标准结构，否则隧道会被拒绝启动。

**自定义实例注意**：使用 `VEILLINK_DATA_DIR` 或自定义端口启动后，`stop.ps1`、`npm run admin:reset`、`npm run upstream:reset` 必须在同一终端设置相同变量，否则会按默认 `data\` 和 `8787` 操作，可能停止或重置错误的实例。建议把这些变量固定在启动脚本/终端配置中。

### 多协议并行（可选）

一个实例同一时间只激活一种直连协议。需要同时提供 Anthropic、OpenAI Responses、OpenAI Chat 时，可运行三个独立实例，例如：

| 实例 | 协议 | 管理端口 | 公网源站端口 | 数据目录 | 建议公网主机名 |
|---|---|---|---|---|---|
| 1 | Anthropic Messages | 8787 | 8788 | `C:\VeilLinkData\anthropic` | `anthropic.example.com` |
| 2 | OpenAI Responses | 8797 | 8798 | `C:\VeilLinkData\responses` | `responses.example.com` |
| 3 | OpenAI Chat | 8807 | 8808 | `C:\VeilLinkData\chat` | `chat.example.com` |

每个实例分别启动：

```powershell
$env:VEILLINK_ADMIN_PORT = "8797"
$env:VEILLINK_PUBLIC_PORT = "8798"
$env:VEILLINK_DATA_DIR = "C:\VeilLinkData\responses"
npm start
```

每个实例使用独立的 Cloudflare 命名隧道和各自数据目录下的 `tunnel\config.yml`；管理端口绝不能进入隧道。`tunnel-setup.ps1` 每次只配置一个主机名，因此需要为每个实例分别运行，指定不同的 `VEILLINK_PUBLIC_PORT`/数据目录，并用 `-TunnelName` 指定唯一隧道名，例如 `-TunnelName veillink-responses`。若只使用一种协议，保留单个 `api.example.com` 即可。

## 日志

- 管理页最多显示最近 100 条请求记录；完整日志在 `data\logs\access.log`。
- 只记录元数据，不记录提示词或密钥。
- 单文件约 5 MB 后轮转到 `access.log.1`。
- 管理页“清空”会清除内存和日志文件；审计动作会重新写入一条“清空请求日志”。
- 排查上游问题时看管理页状态、`server.err.log`、`cloudflared.err.log` 和请求状态码。
- 请求体上限、每密钥速率/并发、全局并发（`globalConcurrent`）、每 IP 速率和认证失败预算位于 `data\config.json` 的 `limits`；管理端没有修改入口，修改后重启服务生效。每密钥速率/并发和每 IP 速率只约束本机 VeilLink 实例，不代表上游配额；上游可能有更低的限制。`upstream.timeoutMs` 是连接空闲超时，不是单次请求总时长，慢请求可占用并发槽直到空闲超时。`upstream.firstEventTimeoutMs` 默认 30000 ms（0–300 秒，0 关闭），只约束流式请求的首个语义事件；上游已返回 200 但没有首个事件时，到期后发送协议错误事件并结束。公网监听的请求接收超时为 120 秒，接近 100 MB 的上传需要足够带宽，否则会先超时。

## 上游配置修改

管理页保存后立即生效，无需重启。已建立的流式连接不会被中途改变。

- 上游地址修改：下一次请求生效。
- 上游密钥：输入新值并保存会替换；未点击清除按钮时，输入框留空表示保持不变。在管理页的保存流程中，只有“清除已保存的密钥”按钮会删除已保存密钥：点击后先确认，保存配置时生效，保存前再点一次可取消。开始输入新密钥时该按钮不可用；清除待生效时“测试上游”会要求先保存或取消。命令行 `npm run upstream:reset` 仍可直接清除已保存的密钥密文。
- 测试上游使用模型列表中的第一个模型，发送一次小请求（最多 64 token）；测试请求的空闲超时不超过 45 秒。
- 上游模型白名单（1–5 个）：修改后下一次请求生效；下游只能选择白名单内的模型。
- 协议：Anthropic Messages / OpenAI Responses / OpenAI Chat 切换后下一次请求生效，公网端点集合随之变化。

## Cloudflare 隧道

命名隧道配置：

```powershell
pwsh -NoProfile -File scripts\tunnel-setup.ps1 -Hostname api.example.com
```

- 首次会打开浏览器进行 Cloudflare 授权；账号密码不经过本项目。
- 只把当前 `VEILLINK_PUBLIC_PORT`（默认 `8788`）写入 ingress；不要把管理端口（默认 `8787`）加入。
- 修改域名的 DNS 后如隧道不工作，检查 Cloudflare 区域状态和 DNS 记录。
- 隧道以 `--protocol http2` 启动，用于改善大请求体传输；不改变隧道配置或 ingress，也不控制 Cloudflare 边缘的响应超时。如果网络无法建立 HTTP/2，必须同时从 `scripts\start.ps1` 和 `scripts\watchdog.ps1` 的 cloudflared 启动参数中移除 `--protocol http2` 并重启隧道，否则 watchdog 重启时会重新加回该参数；不要修改 `config.yml` 的结构。cloudflared 同时监听本机 metrics 端口（默认 `127.0.0.1:20241`，可用 `VEILLINK_TUNNEL_METRICS_PORT` 覆盖），管理页、启动脚本和 watchdog 通过 `/ready` 判断边缘连接是否就绪；不需要也不要把该端口暴露到公网。
- `start.ps1` 等待 `/ready` 至少一条连接；watchdog 发现连续 3 次无就绪连接或进程退出后尝试重启。管理页“公网入口”显示“正常 · N 条连接”“不可用”“未启用”或“状态未知”（watchdog 心跳超过约 30 秒未更新），托盘会在公网入口异常时提示；不要再只根据管理端口是否监听判断公网可用。
- `cloudflared` 日志默认 info，不记录请求头；不要为了排障长期开启 debug，debug 会记录请求头和 URL。启动日志会轮转，保留最近 5 份；故障时先看最新的 `cloudflared.err.log`。
- 更新 cloudflared：从官方 Release 下载新版本，核对 Authenticode 与 SHA-256，替换 `bin\cloudflared.exe`；运行期校验使用 `scripts\tunnel-validate.ps1` 的 `ExpectedHash` 默认值，首次配置还使用 `scripts\tunnel-setup.ps1` 的 `expectedCloudflaredHash`。更新时必须同步修改这两处并保持一致，同时更新 `bin\README.md` 的版本/哈希记录和 `docs\DEPLOY-CLOUDFLARE.md` 的固定版本说明，否则 start.ps1/watchdog 会拒绝启动或重启隧道，文档也会过期。

## 开机自启（可选）

本项目不自动修改系统计划任务。需要时可创建一个当前用户登录时运行的任务：

```powershell
$root = "C:\VeilLink"
$action = New-ScheduledTaskAction -Execute "pwsh.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -File `"$root\scripts\start.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName "VeilLink" -Action $action -Trigger $trigger -RunLevel Limited
```

删除：

```powershell
Unregister-ScheduledTask -TaskName "VeilLink" -Confirm:$false
```

注意：笔记本休眠/关机时公网 API 不可用；这是本地网关架构的固有限制。

## 诊断清单

| 现象 | 检查 |
|---|---|
| 管理页打不开 | 服务是否运行、管理端口（默认 8787）是否被占用、Host 是否 `127.0.0.1`；查看 `server.err.log` 是否提示 ACL 失败 |
| 代码/静态页面被其他用户改动 | 运行 `pwsh scripts\setup-acl.ps1` 收紧安装目录 ACL |
| 启动提示 ACL 失败 | 以当前用户运行 `pwsh scripts/setup-acl.ps1`；仅在不支持 ACL 的文件系统上，在启动前设置 `VEILLINK_ALLOW_INSECURE_ACL=1`（`start.ps1` 与 `npm start` 都会识别） |
| 启动时安装目录内有文件并发删除/ Temp 很大 | ACL 收紧对递归 `icacls` 和已消失项按 best-effort 跳过，最终逐项校验仍存在的文件；安装根 `Temp` 作为临时工作区不参与递归 ACL 收紧/校验，只继承根 DACL，不要在其中存放敏感文件；若仍失败，运行 `pwsh scripts/setup-acl.ps1` 重试 |
| 登录 401 | 令牌文件是否最新；停止服务后运行 `npm run admin:reset` |
| 启动提示 data\veillink.lock 不完整 | 确认没有其他 VeilLink 进程使用同一数据目录后，删除该锁文件再启动；不要在有活实例时删除 |
| 启动提示上游密钥无法解密 | `master.key` 被替换/丢失；先停止服务，运行 `npm run upstream:reset`，再启动并在管理端重新输入；reset 前管理端不可达 |
| 管理页提示部分 API Key 无法解密 | `master.key` 与 `keys.json` 不配套；恢复备份的 `master.key`，或在管理端重新生成客户端密钥 |
| 公网 404 | 域名是否 Active；隧道是否运行；请求路径是否属于当前协议（`/v1/messages`、`/v1/responses` 或 `/v1/chat/completions`）；模型是否在白名单 |
| 公网 502 | 服务/上游是否运行；公网源站端口（默认 8788）；上游地址与协议 |
| 管理页显示本地运行但公网超时 | 看概览“公网入口”是否为“不可用”；检查 `cloudflared.err.log` 与 `/ready`；若本机 IPv6 到 Cloudflare 边缘不可达，用 LinkTest 的 `-PreferIpv4` 重试，或检查主机 DNS/IPv6 |
| 客户端 401 | 密钥是否有效/被吊销；是否用了错误字段；设备绑定 |
| 客户端 403 | 密钥绑定了设备但客户端未发 `X-VeilLink-Device` |
| 429 | 全局请求体预算、全局并发、响应处理预算、密钥/IP 速率或并发限制，或认证失败次数预算（默认 30 次/10 分钟/IP）；等待后重试 |
| 413 | 单请求体超过 100 MB 或配置上限，或上游把请求判为过大（上游 413 会映射为通用 `request_too_large`，不转发上游明细） |
| 流式中断 | 上游超时/崩溃；查看日志与 cloudflared 连接 |
| 404 且提示 “Model is not configured” | 客户端 `model` 不在管理端白名单；在管理端添加该模型，或让客户端改用白名单中的 ID |
| 400 且提示 “Request model is required” | 请求体缺少 `model`；messages、count_tokens、Responses 创建/compact、Chat 创建都必须提供白名单内的模型。`/v1/responses/input_tokens` 是例外，可省略 `model` |
| 404 但本机能调 | 当前激活协议与请求端点不匹配（例如 Anthropic 模式下请求 `/v1/responses`）；检查管理端“直连协议” |
| 公网页面出现 HTML | 严重误配；立即停止隧道并检查 ingress 是否指向管理端口（默认 8787） |

## 更新本项目

- 修改代码后运行 `npm test`。
- 重启服务：`scripts\stop.ps1`，再 `scripts\start.ps1`。
- 修改前端静态文件后刷新管理页；静态文件按请求读取，不用重启。
