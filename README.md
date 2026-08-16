# dsh-llm-ustc

DeepSeek Harness `ustc` LLM Provider，访问中国科学技术大学
`https://api.llm.ustc.edu.cn`。插件始终优先直连；仅当 DNS、TCP 或 TLS
建连失败时，才为这个 Provider 的固定目标启动内置 iWAN 用户态隧道。

## 要求

- DeepSeek Harness `0.1.0-rc.6`
- Node.js 24（也支持 Node.js `^22.19.0`）
- Windows、macOS 或 Linux，x64/ARM64
- 科大 LLM API Key
- 公网环境需要完成 iWAN 登录并显式选择线路

## 安装

从 npm 安装到 DSH Web profile：

```sh
dsh plugin --profile web add dsh-llm-ustc@latest
```

如需固定版本，可以将 `latest` 换成具体版本号：

```sh
dsh plugin --profile web add dsh-llm-ustc@0.1.0
```

安装时 npm 会通过六个 `optionalDependencies` 之一自动选择当前操作系统和架构的
原生 helper；不支持的平台或缺失的原生包会返回明确错误。安装完成后重启正在运行的
DSH Web 进程。

打开 DSH Web 的“设置 -> 插件 -> 插件配置”，展开“科大大模型”：

1. 保存 API Key（凭据引用固定为 `USTC_LLM_API_KEY`），并同步模型目录。
2. 公网使用时启动 USTC 登录，在浏览器完成认证后粘贴完整回调 URL，再显式选择一条线路。

模型 ID 直接来自 `/v1/models`。首次离线时仅显示
`deepseek-v4-flash-ascend` 引导项；同步成功后会缓存最近可用目录。

## 网络边界

- helper 只监听随机 `127.0.0.1` 端口，并要求每次启动生成的会话令牌。
- 数据面只接受 `GET /v1/models` 和 `POST /v1/chat/completions`。
- 上游固定为 `api.llm.ustc.edu.cn:443`，Host 和 TLS SNI 不可配置。
- 拒绝绝对 URL、`CONNECT`、任意路径、任意 Host 和 SOCKS IP 目标。
- helper 和 OIDC/控制面客户端忽略 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与
  `NO_PROXY`；插件不会修改进程外的环境变量。
- 不创建 TUN 设备，不修改系统 DNS、代理、路由表或其他 DSH Provider 的网络流量。
- `401/403/429/5xx` 是合法 HTTP 响应，不触发 iWAN 切换。
- 请求收到响应头或响应字节后不会重放；流中断只会影响下一次请求的路由。

进入 iWAN 模式后，helper 每五分钟（带抖动）执行一次直连探测，任意合法 HTTP
响应都会恢复直连。隧道断线按 1 秒起步、30 秒封顶的抖动指数退避重建。

## 凭据与本地状态

- `USTC_LLM_API_KEY`：科大 LLM API Key。
- `USTC_LLM_IWAN_CONFIG`：插件私有 iWAN 凭据，不写入 Provider 配置。
- `$DSH_HOME/plugins/dsh-llm-ustc/state.json`：模型缓存与非敏感状态。

## 验证

```sh
pnpm check
pnpm test:ts
cargo test --manifest-path helper/Cargo.toml
pnpm build
```
