# dsh-hainnu

在 DSH 里登录海南师范大学账号，把学校自部署的 DeepSeek 接成 DSH 的模型。

> 由 DeepSeek-V4.1（2026-10-17）编写 · 欢迎海师师生使用

![用量面板](docs/images/panel.png)

## 这是什么

一个 DSH 插件。装好之后，左侧栏会多一个「海师账号」入口：

- 填一次学号/工号和密码，之后自动登录，令牌过期会自动续；
- 本机起一个 OpenAI 兼容的代理，把学校的模型接进 DSH 的模型列表，新会话可以直接选它；
- 面板里能看到登录状态、代理状态，以及经过代理的 token 用量和活动热力图。

接进来的模型分两个来源，名字里直接标出来：

| 模型 | 来源 | 上下文 / 输出 |
| --- | --- | --- |
| `deepseek-flash` | 海师自部署 | 300,000 / 80,000 |
| `kimi-k3` | 海师阿里云 | 1,000,000 / 8,192 |
| `qwen3.8-flash` | 海师阿里云 | 256,000 / 8,192 |
| `deepseek-v4.1-flash` | 海师阿里云 | 1,000,000 / 8,192 |

自部署那个走学校的 Open WebUI（`chat.hainnu.edu.cn`），后三个走「海师大智汇」
智能体平台（`hsaixy.hainnu.edu.cn`）背后的阿里云百炼，两者共用同一套学号密码，
插件会用同一份凭据各自登录、各自续期。多轮对话优先复用平台会话（只发新增的那条
消息），会话对不上时自动新开一个并带上完整上下文。

三个平台模型的差异：

- **思考**：平台只有开关没有档位。DSH 里选 **off** 就不带思考，其余档位保持平台默认（开）。
- **温度**：Kimi K3 固定 1（改温度平台会报错），Qwen3.8 / DeepSeek V4.1 用 0.7。
- **工具**：平台没有原生 function calling，插件用 `<tool_call>` 文本协议把它们接成
  标准 `tool_calls`，所以这三个模型在 DSH 里能正常读文件、跑命令、调用工具。

密码和令牌只加密存在本机，仓库里没有任何凭据。

## 安装

前置：DSH 桌面版（0.2.x）。

**1. 下载本仓库到任意目录**（下文记作 `<插件目录>`，例如 `D:\dsh\dsh-hainnu`）。

**2. 链接进 DSH 的 profile：**

```bat
:: Windows（cmd，junction 不需要管理员权限）
mklink /J %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-hainnu <插件目录>
```

```bash
# macOS / Linux
ln -s "<插件目录>" ~/.dsh/profiles/desktop/node_modules/dsh-hainnu
```

**3. 在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加：**

```yaml
- insert:
    - id: dsh-hainnu
      name: dsh-hainnu
      config:
        port: 8787
        localApiKey: sk-hainnu
        autoStart: true
        autoLogin: true
```

> `id: dsh-hainnu` 在同一份文件里只能出现一次。

**4. 重启 DSH**，打开左侧栏「海师账号」，填账号密码登录。

## 使用

面板从上到下：

- **状态** —— 登录、令牌有效期、代理地址、当前模型
- **可用模型** —— 四个模型的来源、上下文 / 输出上限、能否看图、工具调用是原生还是模拟，以及每个模型适合干什么
- **用量** —— 经过代理的累计 token、单日峰值、最长任务用时、连续天数和活动热力图
- **账号** —— 登录 / 只存密码 / 退出登录 / 忘记密码
- **代理** —— 启动、停止、重启、重新写入模型配置
- **诊断** —— 最近一次错误的原因

## 配置

配置写在上面第 3 步的 `config` 里，常用的几个：

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `8787` | 本地代理端口，被占用会自动顺延 |
| `autoLogin` | `true` | 启动时令牌不可用就自动登录 |
| `autoStart` | `true` | DSH 启动时自动拉起代理 |
| `allowRemote` | `false` | 从其他设备远程访问 DSH 时才需要打开 |

完整配置项、模型策略和接口清单见 [docs/技术细节.md](docs/技术细节.md)。

## 常见问题

**8787 被旧项目的 Python 代理占用怎么办？**
不用管。插件不会抢端口，识别出是同一个海师代理后会直接接管它（面板显示「接管外部实例」），外部实例退出后 30 秒内自动接手。

**改了 `cordis.patch.yml` 没生效？**
只改注释不会触发重载，`config` 里的实际值变了才会。

**侧栏没有出现「海师账号」？**
先确认 `cordis.patch.yml` 里 `dsh-hainnu` 只出现了一次；再看浏览器控制台有没有 `slot entry crashed`。

## 说明

- 学校**连续 5 次密码错误会锁账号**。插件不会盲目重试：自动登录连续失败会暂停一段时间再试。
- 密码只允许提交到学校自己的域名；本地代理没配好访问 Key 时直接拒绝请求，而不是放行。
- 所有端口只监听本机回环地址，并对请求来源做校验。
- 只支持 OpenAI 兼容接口（`/v1/chat/completions`）。

## 开发

```bash
npm test
```

全部是离线测试，不联网、不碰真实令牌。

## 许可证

MIT。登录流程与代理转发语义来自 [hainnu-proxy](https://github.com/sapphirestar46/hainnu-proxy)（MIT），本项目把它重写成了 DSH 插件。
