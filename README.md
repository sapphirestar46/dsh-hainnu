# dsh-hainnu — 在 DSH 里登录海师账号

参考 [hainnu-proxy](https://github.com/sapphirestar46/hainnu-proxy) 做的 DSH 插件。装好之后：

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

## 测试

```bash
node test/proxy-smoke.mjs    # 假上游：鉴权/归一化/SSE/重试/401/health/端口接管
node test/login-smoke.mjs    # 假 CAS：表单解析、令牌校验、密码错误、锁定、假 JWT 陷阱
node test/client-smoke.mjs   # 客户端模块契约：slot 注册形状、中文标签、样式表
```

三个都是离线测试，不联网、不碰真令牌。

## 许可证与致谢

MIT。登录流程、代理转发语义和 DSH 配置写入逻辑来自
[hainnu-proxy](https://github.com/sapphirestar46/hainnu-proxy)（MIT），
本项目是把那套流程重写成 DSH 插件、并在 Node 里重新实现代理。

本插件只做「把本校已授权的模型接进 DSH」这一件事：
账号密码是使用者自己的，令牌只在本机内存与加密文件里流转，
仓库里不会有任何凭据。

## 已知限制

- 面板的实际渲染效果**没有在浏览器里验证过**：本会话的浏览器无法打开 DSH 自身页面
  （`ERR_BLOCKED_BY_CLIENT`），所以只验证了模块契约、语法和 Host 路由。
  如果左侧栏入口没出现，先看浏览器控制台有没有 `slot entry crashed`。
- 首次登录需要用户手动填一次密码；之后靠密文自动续期。
