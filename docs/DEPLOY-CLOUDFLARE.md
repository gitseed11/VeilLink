# Cloudflare 固定公网入口部署

本文件记录需要你本人完成的注册、付款和授权操作，以及之后的自动化步骤。助手不会接触你的账号密码、支付卡信息或 Cloudflare 登录凭据。

> 以下步骤以示例域名 `example.com` 为例；实际域名、注册商、价格和 Cloudflare 账号以你的控制台为准。

具体操作以腾讯云为例；其他注册商只需完成相同的 NS 修改。

当前选定方案：

- 注册商：腾讯云（示例；域名价格以控制台为准）
- 域名：`example.com`
- DNS/CDN：Cloudflare 免费套餐
- 公网主机名：`api.example.com`（当前实例；可按协议拆分为 `anthropic.` / `responses.` / `chat.`）
- 隧道：Cloudflare Named Tunnel，仅出站，默认指向本机 `127.0.0.1:8788`（由 `VEILLINK_PUBLIC_PORT` 决定）

一个 VeilLink 实例同一时间只激活一种直连协议。若需要同时提供三种协议，请参考 [OPERATIONS.md](OPERATIONS.md) 的多实例表，为每个实例创建独立隧道和主机名；`tunnel-setup.ps1` 每次只写入一个 hostname，请用不同的 `-TunnelName`（例如 `veillink-responses`）区分实例。若只使用一种协议，保留 `api.example.com` 即可。
- cloudflared：项目内固定版本 `2026.11.0`，创建隧道/启动隧道前会校验 SHA-256

## 一、购买域名（需要你操作）

1. 打开腾讯云域名注册控制台 <https://console.cloud.tencent.com/domain>，登录账号并完成实名认证（如要求）。
2. 在“域名注册”搜索你计划注册的域名，确认可注册后加入购物车。选择 1 年即可。
3. 域名价格以结算页为准；续费价格通常明显更高，请留意到期时间。
4. 按页面提示开启域名隐私保护；不需要购买主机、邮箱、SSL 或建站套餐。
5. 在腾讯云账号安全设置中启用 2FA。

价格提示：特惠价只适用于首年或特定活动，续费前请先在控制台确认价格。

## 二、添加到 Cloudflare（需要你操作）

1. 打开 <https://dash.cloudflare.com/sign-up> 创建账号，或 <https://dash.cloudflare.com/login> 登录。启用 2FA。
2. 在 Cloudflare 仪表盘选择 **Domains → Onboard a domain**（旧界面为 **Add a site**）。
3. 输入你注册的域名，选择 **Free** 套餐。
4. Cloudflare 会显示两个分配给你的 nameservers，例如：

   ```text
   xxx.ns.cloudflare.com
   yyy.ns.cloudflare.com
   ```

   实际值以仪表盘为准。

5. 回到腾讯云域名注册控制台 → **我的域名** → 该域名 → **管理** → **DNS 服务器** → **修改**（不同控制台版本也可能显示在“DNS 解析 DNSPod → DNS 设置”下）。
6. 选择 **自定义 DNS / 使用非腾讯云 DNS**，填入 Cloudflare 的两个 NS，提交并完成身份验证。
7. 如果腾讯云侧已启用 DNSSEC，请先关闭 DNSSEC，再改 NS，避免解析中断。
8. 回到 Cloudflare 点击检查；等待域名状态变为 **Active**。通常 10–30 分钟，最长可能 24–48 小时。
9. 激活后，在 Cloudflare **SSL/TLS → Overview** 保持 **Automatic** 或选择 **Full (strict)**；不要选 **Flexible**。在 **SSL/TLS → Edge Certificates** 开启 **Always Use HTTPS**。

## 三、通知助手进行隧道授权

当 Cloudflare 中域名状态为 **Active** 后，告诉助手“域名已 Active”。随后：

> 注意：域名仍为 Pending/未 Activated 时，不要运行 `tunnel-setup.ps1` 或手动启动命名隧道。`tunnel-setup.ps1` 会因没有可授权的 zone 而失败，DNS route 也会失败；`scripts/start.ps1` 只有在 `data\tunnel\config.yml` 已存在时才启动隧道，不会自动提前创建。

1. 助手运行 `cloudflared tunnel login`。
2. 你的默认浏览器会打开 Cloudflare 授权页。
3. 你登录并选择你的域名所属区域，点击授权。
4. 浏览器显示成功后可关闭页面。

此过程助手不读取你的 Cloudflare 密码，也不需要你的 Global API Key。授权生成的 `cert.pem` 和隧道凭据保存在 `data\tunnel\`，受 ACL 保护。

## 四、创建命名隧道（助手或你执行）

```powershell
cd "C:\VeilLink"
pwsh -NoProfile -File scripts\tunnel-setup.ps1 -Hostname api.example.com
```

脚本会先校验 `cloudflared.exe` 的固定 SHA-256，再收紧安装目录与数据目录 ACL。然后：

- 创建名为 `veillink` 的隧道（若已存在则复用）。
- 将凭据写入 `data\tunnel\veillink.json`。
- 创建 `api.example.com` 的 CNAME（Cloudflare Tunnel）。
- 写入 `data\tunnel\config.yml`，入口只有：

  ```yaml
  ingress:
    - hostname: api.example.com
      service: http://127.0.0.1:8788
    - service: http_status:404
  ```

  默认 service 端口为 `8788`；如设置了 `VEILLINK_PUBLIC_PORT`，脚本会写入该端口。`start.ps1` 启动前会校验配置结构并运行 `cloudflared tunnel ingress validate` / 多路径 `ingress rule`；目标端口不一致、出现多个 hostname、quoted 映射键、`path` 规则、flow 映射/anchors/aliases/merge keys、显式 `?` 键、反斜杠转义/escape sequences、`originRequest`/`httpHostHeader`/debug 日志时会拒绝启动隧道；配置还必须与 `tunnel-setup.ps1` 生成的标准结构完全匹配。隧道以 `--protocol http2 --loglevel info --no-autoupdate` 启动；HTTP/2 只改变传输方式，不改变 ingress。如果网络无法建立 HTTP/2，从 `scripts\start.ps1` 的 cloudflared 启动参数中移除 `--protocol http2` 并重启隧道即可。

如果 DNS 记录已存在，脚本会失败而不会覆盖；确认无误后可加 `-ForceDns`。

## 五、启动服务与隧道

在管理端“公网 API 地址”填入：

```text
https://api.example.com
```

保存配置，然后：

```powershell
cd "C:\VeilLink"
pwsh -NoProfile -File scripts\start.ps1
```

`start.ps1` 会在后台启动 Node 服务和命名隧道，并启动 watchdog 绑定两者生命周期；日志在 `data\logs\`。日常使用时也可以直接双击桌面 VeilLink 快捷方式。停止：

```powershell
cd "C:\VeilLink"
pwsh -NoProfile -File scripts\stop.ps1
```

更推荐右键托盘图标 → **停止 VeilLink…** 并确认；命令行停止同样会弹出确认框，自动化可加 `-Force`。

## 六、验收检查

1. **公网根路径不暴露前端**：

   ```bash
   curl -i https://api.example.com/
   ```

   应返回 JSON 404，不能出现 VeilLink 管理页面 HTML。

2. **公网管理 API 不可达**：

   ```bash
   curl -i https://api.example.com/admin/api/state
   ```

   应返回 404。

3. **无效密钥被拒绝**（以当前激活协议为例；Anthropic 模式）：

   ```bash
   curl -i https://api.example.com/v1/messages \
     -H "x-api-key: sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" \
     -H "content-type: application/json" \
     --data '{"model":"x","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'
   ```

   应返回 401，响应中不能包含管理令牌、上游密钥或完整客户端密钥。OpenAI 模式应改用 `/v1/responses` 或 `/v1/chat/completions`，401 响应为 OpenAI 错误格式。

4. **有效密钥可调用**：在管理端生成新密钥后，按当前协议请求：
   - Anthropic：`/v1/messages`；
   - OpenAI Responses：`/v1/responses`；
   - OpenAI Chat：`/v1/chat/completions`。
   模型名必须是管理端白名单中的原样 ID；未知模型应返回 404。
5. **模型发现**：`GET /v1/models` 返回白名单；Anthropic 模式为 `data/first_id/last_id` 结构，OpenAI 模式为 `object: "list"` 结构。
6. **吊销立即生效**：管理端吊销该密钥，再次请求应返回 401。
7. **Claude Code**：配置公网 Base URL 与密钥，运行 `/status` 确认 Base URL，再发送普通问题和一次需要工具调用的问题（Anthropic 模式）。
8. **OpenAI SDK / Codex**：用 Responses 或 Chat 模式配置 Base URL、密钥和白名单模型，发送普通请求与流式请求。
9. **ZCode**：按 [CLIENTS.md](CLIENTS.md) 添加自定义 Anthropic 供应商，测试模型并发送对话。

## 常见部署问题

- **Cloudflare 域名一直 Pending**：Cloudflare 的 NS 与腾讯云“DNS 服务器”中保存的不完全一致，或 DNSSEC 未关闭。用 `nslookup -type=NS example.com` 检查；腾讯云控制台也提供“域名健康检测”工具。
- **cloudflared login 没有打开浏览器**：复制终端打印的 URL 到浏览器打开；授权完成后回到终端。
- **没有可授权的 zone**：域名尚未 Active，或登录了错误的 Cloudflare 账号。
- **DNS route 失败**：通常表示域名不在该 Cloudflare 账号/区域，或同名记录已存在。不要盲目强制覆盖已有非隧道记录。
- **526/SSL 错误**：把 Cloudflare SSL/TLS 改为 Automatic 或 Full，确认不是 Flexible；检查隧道配置的 service 是当前 `VEILLINK_PUBLIC_PORT`（默认 `http://127.0.0.1:8788`）。
- **公网 502**：本机 VeilLink 服务未启动、公网源站端口不是当前 `VEILLINK_PUBLIC_PORT`（默认 8788），或上游不可用。查看 `data\logs\server.out.log` 和管理端最近请求。
- **公网 404 但本机能调**：隧道 hostname 与请求域名不一致，或 Cloudflare DNS 有旧记录。
- **流式被缓冲**：不要在前面再加会缓冲 SSE 的反向代理；Cloudflare Tunnel 本身支持流式。
