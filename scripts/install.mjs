import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPluginPackage } from '../lib/installer.mjs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error('安装失败：需要 Node.js >= 22.13（WebSocket 原生支持）。');
  process.exit(1);
}

const cliArgs = process.argv.slice(2);
const homeIdx = cliArgs.indexOf('--home');
const customHome = homeIdx >= 0 ? cliArgs[homeIdx + 1] : undefined;
const noStart = cliArgs.includes('--no-start');
const jsonOutput = cliArgs.includes('--json');

try {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = await installPluginPackage({
    sourceRoot,
    home: customHome,
    startSidecarIfNeeded: !noStart
  });
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`已安装 ${result.pluginId} v${result.version} -> ${result.destination}`);
    console.log(
      `文件校验通过 (${result.fileCount} 个文件) | 后台服务: ${result.runtimeStarted ? '运行中' : '待启动'} | 界面接入: ${result.uiHealthy ? `已连接 (${result.attachedWindows} 个窗口)` : '等待窗口连接'}`
    );
  }
} catch (error) {
  console.error(`安装失败：${error.message}`);
  process.exitCode = 1;
}
