# VeilLink 1.1.0-rc2 参数补丁

VeilLink 1.1.0-rc2 是基于 1.1.0（rc1）的参数补丁与小升级。本补丁只提供部署参数建议和迁移说明，不包含服务端代码变更；云端仓库代码仍为 1.1.0。

## 与 1.1.0 的关系

- 1.1.0（rc1）是当前稳定基线。
- 1.1.0-rc2 是建立在 1.1.0 上的补丁级小升级，不改变 API、协议、存储格式或管理页交互。
- 本 release 只新增/更新 `PATCH.md`，不修改 `src/`、`web/`、`scripts/` 下的代码；如需把建议值固化为代码默认值，需要另行提交代码变更。

## 推荐参数

| 参数 | 1.1.0 默认 | 1.1.0-rc2 建议 |
|---|---:|---:|
| `upstream.timeoutMs` | `300000`（300 秒） | `2400000`（2400 秒） |
| `limits.concurrentPerKey` | `6` | `12` |
| `limits.requestsPerMinutePerKey` | `120` | `240` |
| Cloudflare 隧道传输 | provider 默认 | `--protocol http2` |

## 在 1.1.0 上应用

### 并发与速率

在 `<数据目录>/config.json` 中显式设置：

```json
{
  "limits": {
    "concurrentPerKey": 12,
    "requestsPerMinutePerKey": 240
  }
}
```

`limits` 在进程启动时读取，修改后重启服务。每 IP 600 次/分钟的限制保持不变，仍会约束多 Key 的聚合流量。

### 超时

目标值是 `upstream.timeoutMs: 2400000`，但 **1.1.0 的代码校验上限是 `900000`**。直接写入 `2400000` 会被截断，通过管理 API 更新会被拒绝。

在未修改代码的 1.1.0 上，可设置的最大值是：

```json
{
  "upstream": {
    "timeoutMs": 900000
  }
}
```

如果确实需要 2400 秒，需要同时放宽 `src/config.js` 中的两处上限（加载归一化和管理 API 校验，`900000` → `2400000`）及对应错误提示。该代码变更不包含在本 release 中，需另行提交。

### HTTP/2

在启动命名隧道时加入 `--protocol http2`：

```text
cloudflared tunnel --config <配置> --no-autoupdate --protocol http2 --loglevel info run
```

1.1.0 的 `scripts/start.ps1` 默认没有这个参数；可在本地启动脚本中加入，或按上面的命令启动隧道。该参数只改变隧道传输方式，不改变隧道配置、证书或 ingress。

## 验证方法

- 管理端状态或配置快照显示 `concurrentPerKey: 12`、`requestsPerMinutePerKey: 240`。
- 设置 900 秒时，`timeoutMs` 显示为 `900000`；若已按说明放宽上限，则显示 `2400000`。
- 托管 cloudflared 日志出现 `protocol=http2`，而不是 `quic`。
- 普通短请求仍然成功，现有 API Key 和模型白名单继续可用。
- 如果部署网络无法建立 HTTP/2，移除 `--protocol http2` 并重启隧道即可回到默认传输；不要修改隧道配置结构。

## 设计说明

- **HTTP/2**：用于改善大请求体在隧道中的传输。公网边缘的源站响应超时不受该参数控制；大请求体在默认传输下可能先被边缘终止，HTTP/2 下可通过。
- **2400 秒是空闲超时**：表示上游连接多久没有数据就断开，不是单次请求的总时长。Cloudflare 边缘、上游供应商和客户端都可能更早超时；长思考或长输出仍应使用流式。
- **并发与速率是本地限制**：`concurrentPerKey` 和 `requestsPerMinutePerKey` 只约束 VeilLink 实例；上游供应商可能有更低的并发或配额限制。
- **风险**：提高并发和速率会把更多压力转移到上游，可能增加 429/529；提高超时会让挂起连接占用并发槽位更久。这些改动不改变密钥、配置结构或已存数据。
- **请求体与模型能力**：请求体默认上限仍为 100 MB；图片、视频、文本的单文件大小和上下文长度仍由上游模型决定。

## 回滚

1. 从启动脚本移除 `--protocol http2`，重启隧道。
2. 将 `<数据目录>/config.json` 恢复为：

   ```json
   {
     "upstream": {
       "timeoutMs": 300000
     },
     "limits": {
       "concurrentPerKey": 6,
       "requestsPerMinutePerKey": 120
     }
   }
   ```

3. 如果曾按说明修改 `src/config.js` 的超时上限，将其恢复为 `900000`。

## 版本与范围

- 1.1.0-rc2 只在本文件和 git tag/release 中标识；`package.json`、README、部署与客户端文档仍保持 1.1.0。
- 本 release 不包含代码变更；参数建议需要由部署者按上述步骤应用。
- 本文件不包含 API Key、上游凭据、隧道凭据、域名、IP、部署路径或机器标识。
