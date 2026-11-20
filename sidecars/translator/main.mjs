import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_VERSION } from '../../lib/constants.mjs';
import { createTranslationCache } from '../../lib/cache.mjs';
import { startCdpHostBridge } from '../../lib/cdp-host.mjs';
import {
  findActiveRuntime,
  servePluginRuntime,
  stopExistingRuntimes
} from '../../lib/runtime-control.mjs';
import {
  createSettingsStore,
  publicSettingsView,
  resolvePluginDataDirectory
} from './sidecar-helpers.mjs';
import { startSidecarAuxServer } from '../../lib/sidecar-ui.mjs';
import {
  checkMagpieGatewayHealth,
  createTranslatorService,
  locateLocalMagpieExecutable,
  startLocalMagpieTray
} from '../../lib/translator.mjs';

export async function startTranslatorSidecar({
  dataDirectory = resolvePluginDataDirectory(),
  sidecarWebPort = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0),
  sidecarUiToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || ''
} = {}) {
  const runtimeDirectory = join(dataDirectory, 'runtime');
  const hasOfficialWebPort = Number.isInteger(sidecarWebPort) && sidecarWebPort > 0;

  if (hasOfficialWebPort) {
    // Supersede any temporary bootstrap process launched prior to Antigravity's native sidecar host
    await stopExistingRuntimes(runtimeDirectory, { purge: false });
  } else {
    const existing = await findActiveRuntime(runtimeDirectory);
    if (existing && existing.version === PLUGIN_VERSION) {
      return { alreadyRunning: true, runtime: existing };
    }
    await stopExistingRuntimes(runtimeDirectory, { purge: false });
  }

  const settingsStore = createSettingsStore({ dataDirectory });
  const cache = createTranslationCache({ dataDirectory });

  let cdpBridge = null;
  const translator = createTranslatorService({
    settingsStore,
    cache,
    onUpdate: update => {
      cdpBridge?.pushTranslationUpdate(update);
    }
  });

  cdpBridge = startCdpHostBridge({
    settingsStore,
    translator,
    cache,
    dataDirectory,
    version: PLUGIN_VERSION
  });

  const closeAuxServer = await startSidecarAuxServer({
    port: sidecarWebPort,
    token: sidecarUiToken,
    version: PLUGIN_VERSION,
    getStatus: async () => {
      const currentSettings = settingsStore.get();
      const [uiHealth, gatewayHealth] = await Promise.all([
        cdpBridge.getHealth(),
        checkMagpieGatewayHealth({
          baseUrl: currentSettings.baseUrl,
          apiKey: currentSettings.apiKey
        })
      ]);
      return {
        version: PLUGIN_VERSION,
        settings: publicSettingsView(currentSettings),
        ui: uiHealth,
        gateway: gatewayHealth,
        magpieInstalled: Boolean(locateLocalMagpieExecutable()),
        metrics: translator.metrics()
      };
    },
    updateSettings: async patch => {
      const updated = settingsStore.set(patch);
      await cdpBridge.notifySettingsChanged(updated);
      return publicSettingsView(updated);
    },
    testTranslate: async () => {
      const startedAt = Date.now();
      const sample =
        'Checking the plugin configuration and verifying that streaming Chinese chain-of-thought translation works end-to-end.';
      const res = await translator.translateParagraph(sample, { forceRetry: true });
      if (res.status === 'done' && res.translation) {
        return {
          ok: true,
          translation: res.translation,
          elapsedMs: Date.now() - startedAt
        };
      }
      return {
        ok: false,
        error: res.error || '翻译未返回有效结果'
      };
    },
    startMagpie: async () => startLocalMagpieTray(),
    clearCache: async () => {
      cdpBridge.notifyCacheCleared();
    }
  }).catch(() => async () => {});

  const closeRuntime = await servePluginRuntime({
    directory: runtimeDirectory,
    version: PLUGIN_VERSION,
    stop: async ({ purge = false } = {}) => {
      if (purge) {
        cdpBridge.notifyCacheCleared();
      }
      await cdpBridge.stop();
      await closeAuxServer();
    },
    getHealth: async () => cdpBridge.getHealth()
  });

  const shutdown = async () => {
    await cdpBridge.stop();
    await closeAuxServer();
    await closeRuntime();
  };

  return { alreadyRunning: false, shutdown, cdpBridge, translator, settingsStore, cache };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const instance = await startTranslatorSidecar();
  if (instance.alreadyRunning) {
    process.exit(0);
  }
  for (const signalName of ['SIGINT', 'SIGTERM']) {
    process.on(signalName, async () => {
      await instance.shutdown();
      process.exit(0);
    });
  }
}
