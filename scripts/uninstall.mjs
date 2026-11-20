import { uninstallPluginPackage } from '../lib/installer.mjs';

const cliArgs = process.argv.slice(2);
const homeIdx = cliArgs.indexOf('--home');
const customHome = homeIdx >= 0 ? cliArgs[homeIdx + 1] : undefined;
const keepSettings = cliArgs.includes('--keep-settings');
const jsonOutput = cliArgs.includes('--json');

try {
  const result = await uninstallPluginPackage({
    home: customHome,
    keepSettings
  });
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`已卸载 agy-thinking-translator (${result.destination})`);
  }
} catch (error) {
  console.error(`卸载失败：${error.message}`);
  process.exitCode = 1;
}
