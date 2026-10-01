# dsh-llm-ustc

DeepSeek Harness `ustc` LLM Provider，访问中国科学技术大学
`https://api.llm.ustc.edu.cn`。插件始终优先直连；仅当 DNS、TCP 或 TLS
建连失败时，才为这个 Provider 的固定目标启动内置 iWAN 用户态隧道。

## 要求

- DeepSeek Harness `0.2.0-rc.2`
- Node.js 24（也支持 Node.js `^22.19.0`）
- Windows、macOS 或 Linux，x64/ARM64
- 科大 LLM API Key，或词元工坊账号
- 公网环境需要完成 iWAN 登录并显式选择线路

## 安装

从 npm 安装到 DSH Web profile：

```sh
dsh plugin --profile web add dsh-llm-ustc@latest
```

如需固定版本，可以将 `latest` 换成具体版本号：

```sh
dsh plugin --profile web add dsh-llm-ustc@0.2.1
```

安装时 npm 会通过六个 `optionalDependencies` 之一自动选择当前操作系统和架构的
原生 helper；不支持的平台或缺失的原生包会返回明确错误。安装完成后重启正在运行的
DSH Web 进程。

在 DSH Web 主页左上角打开“插件”，从“已安装”进入“科大大模型”的详情页：

1. 选择 Key 来源：手动输入 API Key，或登录词元工坊。词元工坊登录时点击“打开登录页面”，在浏览器完成科大认证后会自动返回本机回调，无需粘贴 URL。
2. 同步模型目录。两种来源都使用相同的科大 API、模型目录和聊天链路；切换来源不会回退到另一种凭据。
3. 公网使用时还需单独完成 iWAN 登录：在浏览器认证后粘贴完整回调 URL，再显式选择一条线路。词元工坊登录不替代 iWAN 登录。

词元工坊只用于从官方 bootstrap 服务获取网关 Key。插件验证发布配置签名和 OIDC ID token，使用 PKCE 与十分钟有效的单次本机回调；登录令牌可自动续期，网关 Key 仅缓存在内存中，按官方有效期和重检间隔在请求前刷新。
浏览器须与 DSH Host 在同一台机器上，才能完成 `127.0.0.1` 回调。

模型 ID 直接来自 `/v1/models`。首次离线时仅显示
`deepseek-flash` 引导项；同步成功后会缓存最近可用目录。

## 网络边界

- helper 只监听随机 `127.0.0.1` 端口，并要求每次启动生成的会话令牌。
- 数据面允许访问固定上游 Host 下的任意相对路径、查询参数和 HTTP 方法。
- 上游固定为 `api.llm.ustc.edu.cn:443`，Host 和 TLS SNI 不可配置；拒绝绝对
  URL、`CONNECT`/authority-form、非 loopback 本地 Host 和 SOCKS IP 目标。
- OIDC、控制面签名和线路目录由 Host 侧 TypeScript 处理；helper 只接收当前线路的
  IP、端口、账号和临时解密后的密码，并负责 iWAN 数据面。
- helper 和 Host 侧 OIDC/控制面客户端忽略 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与
  `NO_PROXY`；插件不会修改进程外的环境变量。
- 不创建 TUN 设备，不修改系统 DNS、代理、路由表或其他 DSH Provider 的网络流量。
- `401/403/429/5xx` 是合法 HTTP 响应，不触发 iWAN 切换。
- 请求收到响应头或响应字节后不会重放；流中断只会影响下一次请求的路由。

进入 iWAN 模式后，helper 每五分钟（带抖动）执行一次直连探测，任意合法 HTTP
响应都会恢复直连。隧道断线按 1 秒起步、30 秒封顶的抖动指数退避重建。

## 凭据与本地状态

- `USTC_LLM_API_KEY`：科大 LLM API Key。
- `USTC_LLM_TOKENWORKS_SESSION`：插件私有词元工坊登录令牌，存入 DSH 凭据服务，不写入 Provider 配置或返回给 Web UI；退出登录时清除。手动 Key 独立保存，切换来源时不会删除。
- `USTC_LLM_IWAN_CONFIG`：插件私有 iWAN 凭据，不写入 Provider 配置。
- `$DSH_HOME/profiles/web/cordis.patch.yml`：Key 来源、所选 iWAN 线路和直连恢复间隔，归属 `llm-ustc` 插件配置行；其他 profile 使用自己的同名文件。
- `$DSH_HOME/cache/dsh-llm-ustc/models.json`：可重新同步的模型目录缓存。升级后旧缓存不会迁移，可在插件详情页手动同步。

升级到 DSH 0.2 后，DSH 会在首次启动时把旧 `$DSH_HOME/settings.yaml` 中的插件设置导入当前 profile，并将旧文件改名为 `settings.yaml.imported`。请确保导入时已启用本插件。

## 验证

```sh
pnpm check
pnpm test:ts
cargo test --manifest-path helper/Cargo.toml
pnpm build
```
