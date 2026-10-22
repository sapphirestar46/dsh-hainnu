# dsh-hainnu — 在 DSH 里登录海南师范大学账号

**享受海师自部署的 DeepSeek。欢迎海师师生使用。**

由 DeepSeek-V4.1（2026-10-17）编写，修改自上一个项目 [hainnu-proxy](https://github.com/sapphirestar46/hainnu-proxy)。

装好之后：

1. DSH 左侧栏多一个「**海师账号**」入口；
2. 在里面填**学号/工号 + 密码**，密码用系统密钥加密存在本机；
3. 后台按旧项目同一条流程登录学校统一身份认证（CAS），拿到 Open WebUI 的 JWT；
4. 自动把 `hainnu / deepseek-flash` 写进 DSH 的模型配置（`cordis.patch.yml`）；
5. 每次启动 DSH 时自动把本地代理拉起来，令牌过期会自动重新登录。

## 和旧项目的关系

| | 旧项目 hainnu-proxy | 本插件 |
|---|---|---|
| 取令牌 | `get_token.py` + Playwright 开浏览器，登录后读 `localStorage['token']` | 同一套 CAS 表单/重定向链，纯 HTTP，不需要浏览器 |
| 代理 | Python `hainnu_proxy.py`，`127.0.0.1:8787` | Node 版 `lib/proxy.js`，同样 `127.0.0.1:8787`，OpenAI 兼容语义照抄 |
| 配置 DSH | `一键配置/_setup_agent.py` 写 `cordis.patch.yml` | `lib/modelconfig.js` 按行做外科手术写同一份文件 |
| 开机启动 | `autostart.py` / `4.开机自启.bat` | 插件随 DSH 启动，`apply()` 里拉起代理 |

转发语义与旧项目一致：`role=developer → system`、`max_completion_tokens → max_tokens`、
SSE 原样透传、`429` 冷却 12 秒重试、`401` 触发一次重新登录、4 次退避重试、300 秒超时、
**直连上游不读 HTTP(S)_PROXY**（走本机代理常触发 Open WebUI 的 402）。

### 端口冲突怎么办

如果旧项目的 Python 代理还在跑并占着 8787，插件**不会抢端口**：它会探测 `127.0.0.1:8787/health`，
认出是同一个海师代理后直接「接管」（面板显示"接管外部实例"），模型配置一个字节都不改。
外部实例退出后，插件会在 30 秒内自己接管该端口。
如果 8787 被别的程序占着，插件会顺延到 8788 起，并把 `baseURL` 改成实际端口。

## 安装

把本仓库克隆/下载到任意目录（下面用 `<插件目录>` 指代，例如 `D:\dsh\dsh-hainnu`）。

```bash
# 1) 链接进 profile 的 node_modules
#    Windows（cmd 里执行，junction 不需要管理员权限）
cmd //c "mklink /J %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-hainnu <插件目录>"

#    macOS / Linux
ln -s "<插件目录>" ~/.dsh/profiles/desktop/node_modules/dsh-hainnu
```

```yaml
# 2) 在 %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml 末尾追加
- insert:
    - id: dsh-hainnu
      name: dsh-hainnu
      config:
        port: 8787
        upstream: https://chat.hainnu.edu.cn
        localApiKey: sk-hainnu
        providerId: hainnu
        apiKeyEnv: HAINNU_API_KEY
        modelId: deepseek-flash
        profile: desktop
        autoStart: true
        autoLogin: true
        writeConfig: true
```

保存后 DSH 会自动重载补丁层（也可以刷新页面 / 重启应用）。验证：

```bash
curl http://127.0.0.1:9840/dsh-hainnu/status
```

返回 `{"ok":true,...}` 说明 Host 半边已经挂上。

> 注意：`id` 只能出现一次。如果同一份 patch 里已经有 `dsh-hainnu`，不要再加一条。

## 配置项

| 键 | 默认值 | 说明 |
|---|---|---|
| `port` | `8787` | 本地代理端口（被占用会自动顺延） |
| `upstream` | `https://chat.hainnu.edu.cn` | 学校门户 |
| `localApiKey` | `sk-hainnu` | 本地代理的 Bearer Key |
| `providerId` | `hainnu` | 写进 DSH 的 provider 名 |
| `apiKeyEnv` | `HAINNU_API_KEY` | DSH 凭据里存 Key 的变量名 |
| `modelId` | `deepseek-flash` | 上游模型 id |
| `profile` | `desktop` | 写哪个 profile 的 `cordis.patch.yml` |
| `autoStart` | `true` | DSH 启动时自动起代理 |
| `autoLogin` | `true` | 启动时令牌不可用则用已存密码登录 |
| `writeConfig` | `true` | 是否自动写模型配置 |
| `contextWindow` | `300000` | 写进模型的上下文窗口（= 网关请求体上限，见下节） |
| `maxTokens` | `80000` | 写进模型的输出上限；固定 300,000 窗口时，要 220,000 压缩线就得把输出压到 80,000 |
| `syncModelPolicy` | `false` | `true` 时把已有模型的 `contextWindow`/`maxTokens` 校正成上面的值 |
| `syncCompaction` | `true` | 压缩线够低时自动写按模型的 `modelPolicies` 覆盖 |
| `setDefaultModel` | `true` | 没有别人接管时，把新会话默认模型设成海师 |
| `allowRemote` | `false` | 允许非本机来源访问插件接口（DSH 远程访问时需要） |
| `allowAnonymous` | `false` | 代理不校验本地 Key（只在已被网关挡住时开） |

## 模型策略（这条路由为什么特殊）

学校网关（Open WebUI）对单次请求体有限制：**prompt + `max_tokens` ≤ 300,000**。
所以这条模型不能照抄官方规格，插件会把这套参数一起写进 `cordis.patch.yml`：

| 位置 | 键 | 值 | 为什么 |
|---|---|---|---|
| 模型 | `contextWindow` | `300000` | 网关请求体上限，不是模型能力（模型本身 1M 上下文） |
| 模型 | `maxTokens` | `80000` | 网关默认只有 32,768；取 80,000 是为了让压缩线到 220,000（模型官方输出 64k） |
| 模型 | `input` | `text, image` | 模型支持图片输入 |
| 模型 | `reasoningEfforts` | `off: none` / `low: low` / `max: max` | 官方只有这三档 |
| provider | `compat.thinkingFormat` | `deepseek` | 决定思考字段怎么发 |
| provider | `compat.maxTokensField` | `max_tokens` | 网关只认 `max_tokens` |
| provider | `compat.supportsDeveloperRole` | `false` | 网关没有 developer 角色（插件代理也会把它转成 system） |
| provider | `reasoning` | `max` | 默认思考强度 |
| 压缩 | `compaction-basic.modelPolicies` | `headroomTokens: 0`、`maxTokens: 4000` | 见下 |
| 默认模型 | `agent-default-model` | `hainnu/deepseek-flash`、`reasoningEffort: max` | 新会话直接用海师 |

压缩线为什么必须单独调：DSH 的触发阈值是
`floor(min(W × 0.8, W − O − headroomTokens))`，`headroomTokens` 默认 65,536。

- 默认值下：`min(240,000, 300,000 − 80,000 − 65,536)` = **154,464**，一半上下文白扔。
- 插件写入的按模型覆盖：`min(240,000, 300,000 − 80,000 − 0)` = **220,000**，
  此时 prompt 220,000 + 输出上限 80,000 = 300,000，正好贴住网关上限。

写入范围刻意收紧：只写**按模型**的 `modelPolicies`（`provider: hainnu` + `model: deepseek-flash`），
不改 preset 里全局的 `headroomTokens`（那会连带影响其它 provider）；已经够高、或已有本模型覆盖时一律不动。

## HTTP 接口（Host 半边，面板在用）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-hainnu/status` | 登录/代理/模型/配置状态（不含密码与令牌） |
| POST | `/dsh-hainnu/login` | `{username, password}`；`password` 留空则用已保存的 |
| POST | `/dsh-hainnu/save` | 只保存账号密码，不登录 |
| POST | `/dsh-hainnu/logout` | 清令牌（保留密码） |
| POST | `/dsh-hainnu/forget` | 清密码 + 令牌 |
| POST | `/dsh-hainnu/proxy` | `{action: start\|stop\|restart}` |
| POST | `/dsh-hainnu/apply-config` | 重新检查并写入模型配置 |
| POST | `/dsh-hainnu/refresh-models` | 重新拉上游模型列表 |
| POST | `/dsh-hainnu/settings` | `{autoLogin?, autoStart?}` |

本地代理自己暴露的端点：`GET /health`（形状与旧项目兼容）、`GET /v1/models`、
`POST /v1/chat/completions`。

## 安全与边界

- 密码与 JWT **只以密文落盘**：有 Electron `safeStorage`（Windows 上是 DPAPI）就用它，
  否则退回 AES-256-GCM + 本机派生密钥。明文既不写日志，也不经 HTTP 回传，
  面板只显示 `hasPassword` / `hasToken` 这类布尔量。
- 学校**连续 5 次密码错误会锁账号**，所以插件：自动登录失败 2 次后暂停自动重试（10 分钟窗口），
  手动登录不做任何盲目重试。
- 登录页目前没有验证码；万一门户改版出现验证码，插件会明确报 `captcha` 而不是硬撞。
- 只实现 OpenAI 兼容（`/v1/chat/completions`）。旧项目的 Anthropic `/v1/messages`
  兼容层**没有移植**——DSH 用不到。
- 令牌失效、上游 402/5xx、校园网断开都有独立的中文报错，面板「诊断」卡片里能看到最近一次原因。
- **两个端口都只监听回环地址，但"只监听回环"挡不住浏览器**（DNS 重绑定能让任意网页变成同源）。
  所以插件路由和 8787 代理都会校验 `Host` / `Origin` / `Sec-Fetch-Site`：来源说不清就 403，
  伪造 `Host: evil.example.com`、跨站 `Origin`、`Origin: null` 都会被拒。
- 密码**只准提交到学校自己的域名**：登录页里的 `<form action>` 必须落在
  `auth.hainnu.edu.cn:9443` 或 `chat.hainnu.edu.cn` 的 https origin 上，否则直接报错、
  一个字节的密码都不发出去（防门户被投毒/跳转被劫持把密码带去别处）。
- Cookie 罐**按域隔离**：没带 `Domain` 的按 host-only 存，带了只接受"当前主机或它的父域"；
  发给某一跳的 Cookie 必须和该 URL 的主机匹配。早期版本会把整罐 Cookie 发给任意跳转目标，
  一次跨站重定向就能把学校会话 Cookie 带出去。令牌也只认门户主机种下的那一个。
- 代理的本地 Key 校验**失败关闭**：一个 Key 都没配好时返回 401（而不是旧行为：直接放行）。
- 登录有进程级限流：10 分钟内失败 3 次就整体冷却 10 分钟，手动和自动登录共用同一份预算，
  避免被人反复触发 `/login` 把学校账号刷到锁定。
- 插件接口需要 DSH 自身的登录态（同源页面），不做单独鉴权；本机其它进程属于同一信任域，
  它们本来就能直接读 `~/.dsh/hainnu/state.json`。
- 走 DSH 远程访问（非回环地址）时，需要把 `allowRemote` 设为 `true`，否则面板请求会被 403。

## 测试

```bash
node test/proxy-smoke.mjs    # 假上游：鉴权/归一化/SSE/重试/401/health/端口接管
node test/guard-smoke.mjs    # 入口校验（Host/Origin/Sec-Fetch-Site）与登录限流
node test/login-smoke.mjs    # 假 CAS：表单解析、令牌校验、密码错误、锁定、假 JWT 陷阱、校外 action
node test/client-smoke.mjs   # 客户端模块契约：slot 注册形状、中文标签、样式表
node test/store-smoke.mjs    # 落盘加密：密文不含明文、篡改解不开、publicState 脱敏
node test/modelconfig-smoke.mjs  # 模型策略：压缩线公式、按模型覆盖、幂等、默认模型
```

都是离线测试，不联网、不碰真令牌。`npm test` 会全部跑一遍。

## 许可证与致谢

MIT。登录流程、代理转发语义和 DSH 配置写入逻辑来自
[hainnu-proxy](https://github.com/sapphirestar46/hainnu-proxy)（MIT），
本项目是把那套流程重写成 DSH 插件、并在 Node 里重新实现代理。

本插件只做「把本校已授权的模型接进 DSH」这一件事：
账号密码是使用者自己的，令牌只在本机内存与加密文件里流转，
仓库里不会有任何凭据。

## 常见问题

**改完 `cordis.patch.yml` 没生效？**
只改注释不会触发重载（解析出来的配置没变），改动 `config` 里的实际值才会。

**同时看到两个端口在监听？**
热重载不会重启进程。插件现在会把上一个实例的 server 主动收掉（`globalThis` 单例），
所以从本版本起不会再累积。如果你是从更早的手工调试版本升上来的，
**重启一次 DSH** 清掉遗留的那个监听即可，之后不会再出现。

**面板显示"接管外部实例"是好是坏？**
是好事：说明旧项目的 Python 代理正在 8787 上正常工作，插件直接复用它，
不去抢端口，也不改你的模型配置。

## 已知限制

- 面板的实际渲染效果**没有在浏览器里验证过**：本会话的浏览器无法打开 DSH 自身页面
  （`ERR_BLOCKED_BY_CLIENT`），所以只验证了模块契约、语法和 Host 路由。
  如果左侧栏入口没出现，先看浏览器控制台有没有 `slot entry crashed`。
- 首次登录需要用户手动填一次密码；之后靠密文自动续期。
