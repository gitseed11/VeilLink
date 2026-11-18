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

`start.ps1` 会：

- 收紧并验证安装目录/数据目录 ACL，并校验 `node` 与公网监听器确实由本次启动的进程持有
- 启动 `node src/server.js`，PID 写入 `data\veillink.pid`；命令行带 `--veillink-data-dir=<数据目录>`，避免误匹配其他实例
- 如果 `data\tunnel\config.yml` 存在且 `bin\cloudflared.exe` 可用，先结构校验隧道配置并运行 `cloudflared tunnel ingress validate` / 多路径 `ingress rule`，再启动命名隧道（`--protocol http2 --loglevel info --no-autoupdate`），PID 写入 `data\cloudflared.pid`；校验失败时会停止本实例已有的托管隧道，避免无效配置继续暴露旧入口
- 启动 `watchdog.ps1`，验证其进程身份和存活；服务器退出/崩溃时自动停止隧道；watchdog 无法启动或立即退出时会停止隧道，避免公网继续指向空闲端口
- 将日志写入 `data\logs\server.out.log`、`server.err.log`、`cloudflared.out.log`、`cloudflared.err.log`、`watchdog.log`、`watchdog.out.log`、`watchdog.err.log`

停止（会弹出确认框）：

```powershell
pwsh -NoProfile -File scripts\stop.ps1
```

自动化脚本可跳过确认：

```powershell
pwsh -NoProfile -File scripts\stop.ps1 -Force
```

`stop.ps1` 会先停止隧道，再停止服务器和 watchdog；PID 文件丢失或过期时会按可执行文件路径和当前实例的 `--veillink-data-dir` / 隧道配置路径精确扫描，避免误杀其他实例。清理后若仍有本实例的 node/cloudflared/watchdog 进程，脚本会返回非零；托盘会提示失败并保留图标，便于重试。

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

> 1.2.0 使用配置 schema v2（`models` 数组、`openai-responses` / `openai-chat` 协议名）。从 1.0.0 升级时，启动会自动把旧的 `model` 字符串迁移为单元素 `models`，把旧 `openai` 迁移为 `openai-chat`，并原子重写 `config.json`。如果旧配置已填写上游地址但 `model` 为空，迁移后模型白名单仍为空，公网推理会返回 503；请在管理端添加至少一个模型。运行时会规范化超限/重复模型、无效地址和越界限制，并把规范化结果写回 v2 配置。已有配置中的有效值不会被 1.2.0 的默认值覆盖；加载时仍会做常规规范化（例如去掉 URL 末尾斜杠、去除模型名首尾空白）并写回 `config.json`；无效或越界值按规范化规则处理。
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

- 吊销无需确认，点击后立即生效；旧密钥马上失效，列表标记“已吊销”。
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
- 请求体上限、每密钥速率/并发、每 IP 速率和认证失败预算位于 `data\config.json` 的 `limits`；管理端没有修改入口，修改后重启服务生效。每密钥速率/并发和每 IP 速率只约束本机 VeilLink 实例，不代表上游配额；上游可能有更低的限制。`upstream.timeoutMs` 是连接空闲超时，不是单次请求总时长，慢请求可占用并发槽直到空闲超时。

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
- 隧道以 `--protocol http2` 启动，用于改善大请求体传输；不改变隧道配置或 ingress，也不控制 Cloudflare 边缘的响应超时。如果网络无法建立 HTTP/2，从 `scripts\start.ps1` 的 cloudflared 启动参数中移除 `--protocol http2` 并重启隧道即可回到默认传输；不要修改 `config.yml` 的结构。
- `cloudflared` 日志默认 info，不记录请求头；不要为了排障长期开启 debug，debug 会记录请求头和 URL。
- 更新 cloudflared：从官方 Release 下载新版本，核对 Authenticode 与 SHA-256，替换 `bin\cloudflared.exe`；start.ps1 与 tunnel-setup.ps1 都固定校验当前版本哈希，更新时必须同步修改脚本中的 `expectedCloudflaredHash`，否则隧道会被拒绝启动。

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
| 登录 401 | 令牌文件是否最新；停止服务后运行 `npm run admin:reset` |
| 启动提示上游密钥无法解密 | `master.key` 被替换/丢失；先停止服务，运行 `npm run upstream:reset`，再启动并在管理端重新输入；reset 前管理端不可达 |
| 管理页提示部分 API Key 无法解密 | `master.key` 与 `keys.json` 不配套；恢复备份的 `master.key`，或在管理端重新生成客户端密钥 |
| 公网 404 | 域名是否 Active；隧道是否运行；请求路径是否属于当前协议（`/v1/messages`、`/v1/responses` 或 `/v1/chat/completions`）；模型是否在白名单 |
| 公网 502 | 服务/上游是否运行；公网源站端口（默认 8788）；上游地址与协议 |
| 客户端 401 | 密钥是否有效/被吊销；是否用了错误字段；设备绑定 |
| 客户端 403 | 密钥绑定了设备但客户端未发 `X-VeilLink-Device` |
| 429 | 密钥/IP 速率或并发限制；等待后重试 |
| 413 | 请求体超过 100 MB 或配置上限 |
| 流式中断 | 上游超时/崩溃；查看日志与 cloudflared 连接 |
| 404 且提示 “Model is not configured” | 客户端 `model` 不在管理端白名单；在管理端添加该模型，或让客户端改用白名单中的 ID |
| 400 且提示 “Request model is required” | 请求体缺少 `model`；messages、count_tokens、Responses 创建/compact、Chat 创建都必须提供白名单内的模型。`/v1/responses/input_tokens` 是例外，可省略 `model` |
| 404 但本机能调 | 当前激活协议与请求端点不匹配（例如 Anthropic 模式下请求 `/v1/responses`）；检查管理端“直连协议” |
| 公网页面出现 HTML | 严重误配；立即停止隧道并检查 ingress 是否指向管理端口（默认 8787） |

## 更新本项目

- 修改代码后运行 `npm test`。
- 重启服务：`scripts\stop.ps1`，再 `scripts\start.ps1`。
- 修改前端静态文件后刷新管理页；静态文件按请求读取，不用重启。
