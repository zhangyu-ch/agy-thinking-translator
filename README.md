<div align="center">
  <img src="assets/logo.svg" width="72" height="72" alt="Agy Thinking Translator Logo" />
  <h1>Agy Thinking Translator</h1>
  <p><strong>Antigravity 2.0 思维链自动展开与中文实时流式翻译插件</strong></p>
  <p>
    <a href="https://github.com/zhangyu-ch/agy-thinking-translator/actions/workflows/ci.yml"><img src="https://github.com/zhangyu-ch/agy-thinking-translator/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-16a34a" alt="MIT License" /></a>
    <img src="https://img.shields.io/badge/Node.js-%3E%3D22.13-339933" alt="Node.js >= 22.13" />
    <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-475569" alt="Platform" />
  </p>
</div>

## 简介

**Agy Thinking Translator** 是专为 Google Antigravity 2.0 打造的思维链增强与实时中文翻译插件（翻译拆分逻辑参考自 [pi-thinking-translator](https://github.com/zhangyu-ch/pi-thinking-translator)，无损挂载方式兼容 [Agy Powertools](https://github.com/WhiteBr1ck/agy-powertools)）。

Antigravity 默认将模型的英文推理思维链折叠隐藏。启用本插件后：

1. **执行过程中自动保持英文思维链展开**：模型正在思考时，原英文思维链自动展开实时滚动（即使客户端会话详情处于 `Concise` 简洁模式也会自动呈现思考步骤）。
2. **思考完成后英文自动收起、中文译文常驻展开**：单步思考结束变为 `Thought for Xs >` 后，原英文思维链自动折叠收起；紧跟其正下方的**中文译文块始终保持展开状态**（左侧竖线缩进 + 斜体排版，完整保留代码块、行内代码与加粗格式）。
3. **逐段流式并行翻译（接入本地 Magpie `group/ds-flash`）**：按段落智能切分思维链（保护代码块不拆断、自动合并独立标题），每完成一段即刻后台调用本机 OpenAI 兼容接口（默认 `http://127.0.0.1:3425/v1`，模型 `group/ds-flash`，思考等级 `low`）实时流式输出中文。
4. **零上下文污染与磁盘持久化缓存**：译文仅在前端渲染层展示，绝不改写原始会话消息，不消耗任何后续对话上下文 Token；已翻译段落按 SHA-256 持久化缓存在本地磁盘，切换会话或重启客户端零延迟秒开。
5. **无损安装与插件共存**：纯文件校验同步，零第三方依赖（无需 `npm install`），不修改客户端安装文件或 `~/.gemini/config/config.json`，与 `Agy Powertools` 完全无冲突共存。

## 环境要求

- Antigravity 2.0 桌面客户端（已开启本机调试端口 `DevToolsActivePort`）
- Node.js `>= 22.13`
- 本机运行 [Magpie](https://usemagpie.ai) 网关（默认监听 `http://127.0.0.1:3425/v1` 并配置 `group/ds-flash` 模型，也可在右侧辅助面板自定义任意 OpenAI 兼容接口）

## 安装与卸载

### 方式一：复制提示词交给 Agent 自动安装（推荐）

将以下提示词直接发送给 Antigravity 或其他本地 Agent：

> 请帮我安装 Agy Thinking Translator：https://github.com/zhangyu-ch/agy-thinking-translator 。先阅读 README.md 和 docs/INSTALL_AGENT.md，使用项目自带的 install.ps1（或 install.sh）完成安装，保留已有插件、账户配置与聊天记录，不要强制退出当前客户端，安装后验证运行状态并告诉我结果。

详细步骤参阅 [Agent 自动安装指南](docs/INSTALL_AGENT.md)。

### 方式二：命令行手动安装

克隆仓库并在项目根目录执行：

Windows (PowerShell)：

```powershell
git clone https://github.com/zhangyu-ch/agy-thinking-translator.git
cd agy-thinking-translator
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

macOS / Linux：

```sh
git clone https://github.com/zhangyu-ch/agy-thinking-translator.git
cd agy-thinking-translator
sh ./install.sh
```

### 卸载

Windows (PowerShell)：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

macOS / Linux：

```sh
sh ./uninstall.sh
```

如需保留个人设置与历史翻译缓存，可在卸载命令末尾附加 `--keep-settings`。

## 配置项说明

插件内置官方 Sidecar 辅助面板（客户端右侧辅助栏 **思维链翻译**），所有开关均支持实时生效并自动持久化保存至 `~/.gemini/antigravity/plugin_data/agy-thinking-translator/settings.json`：

| 配置项 | 字段名 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 启用插件 | `enabled` | `true` | 插件全局总开关，关闭后立即移除页面注入的译文块 |
| 思考过程中保持英文展开 | `expandEnglishWhileThinking` | `true` | 模型正在生成思维链时自动保持原英文区域展开 |
| 思考完成后自动收起英文 | `collapseEnglishWhenDone` | `true` | 单步思考完成后自动收起英文原文，仅保留下方中文展开 |
| 中文思维链常驻展开 | `keepChineseExpanded` | `true` | 在 `Thought for Xs >` 正下方始终展开显示中文译文 |
| 保持外层步骤/用时栏展开 | `keepContainersExpanded` | `true` | 含思维链时默认保持外层 `用时 / 工具组` 展开，防止遮挡中文译文（仍可手动点击折叠） |
| 简洁模式强制显示思维链 | `forceVerboseSteps` | `true` | 客户端设为 `Concise` 时依然渲染思维链与中文译文 |
| 翻译接口地址 | `baseUrl` | `http://127.0.0.1:3425/v1` | 自动从 `~/.config/magpie/gateway.json` 或 `~/.pi/agent/models.json` 发现，支持自定义 |
| 翻译模型 ID | `translatorModel` | `group/ds-flash` | 用于思维链翻译的模型标识（自动兼容 `magpie/` 前缀） |
| 思考等级 | `translatorThinking` | `low` | 可选 `low` / `minimal` / `off` / `medium` / `high` / `xhigh` / `max` |

## 开发与测试

```bash
node --test test/plugin.test.mjs
```

## 开源协议

基于 [MIT License](LICENSE) 开源。
