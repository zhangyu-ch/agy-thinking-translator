# Agent 自动安装指南

适用于 Antigravity 2.0、Codex 等可执行本地终端命令的智能体。安装过程为纯文件校验同步，无需 `npm install`，不要求管理员权限，不改写 `~/.gemini/config/config.json` 或客户端安装包。

## 从本地目录安装

1. 核对目录内包含 `plugin.json`，且 `name` 为 `agy-thinking-translator`。
2. Windows 执行：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```
   macOS / Linux 执行：
   ```sh
   sh ./install.sh
   ```
3. 检查退出码为 `0`，并核对 `~/.gemini/config/plugins/agy-thinking-translator/.install-receipt.json`。
4. 告知用户安装与窗口连接结果；不要强制关闭正在运行当前会话的 Antigravity 客户端。

## 从 GitHub 安装

先克隆仓库到本地目录，再执行统一安装入口：

```powershell
git clone https://github.com/zhangyu-ch/agy-thinking-translator.git
cd agy-thinking-translator
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

### 一键复制给 Agent 的安装提示词

> 请帮我安装 Agy Thinking Translator：https://github.com/zhangyu-ch/agy-thinking-translator 。先阅读 README.md 和 docs/INSTALL_AGENT.md，使用项目自带的 install.ps1（或 install.sh）完成安装，保留已有插件、账户配置与聊天记录，不要强制退出当前客户端，安装后验证运行状态并告诉我结果。

## 卸载

Windows：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

macOS / Linux：

```sh
sh ./uninstall.sh
```

如需保留个人设置与历史翻译缓存，可在命令末尾添加 `--keep-settings`。
