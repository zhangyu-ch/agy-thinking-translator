import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MAGPIE_API_KEY,
  DEFAULT_MAGPIE_BASE_URL,
  DEFAULT_TRANSLATOR_MODEL,
  DEFAULT_TRANSLATOR_THINKING_LEVEL,
  PLUGIN_ID,
  VALID_THINKING_LEVELS
} from './constants.mjs';

export function resolvePluginDataDirectory({ home = homedir(), env = process.env } = {}) {
  const appDataDir = env.ANTIGRAVITY_APP_DATA_DIR || join(home, '.gemini', 'antigravity');
  return join(appDataDir, 'plugin_data', PLUGIN_ID);
}

export function resolveAntigravityUserDataDirectory({
  platform = process.platform,
  env = process.env,
  home = homedir()
} = {}) {
  if (env.ANTIGRAVITY_USER_DATA_DIR) return env.ANTIGRAVITY_USER_DATA_DIR;
  const pathImpl = platform === 'win32' ? win32 : posix;
  if (platform === 'win32') {
    return pathImpl.join(env.APPDATA || pathImpl.join(home, 'AppData', 'Roaming'), 'Antigravity');
  }
  if (platform === 'darwin') {
    return pathImpl.join(home, 'Library', 'Application Support', 'Antigravity');
  }
  return pathImpl.join(env.XDG_CONFIG_HOME || pathImpl.join(home, '.config'), 'Antigravity');
}

export function resolveDevToolsActivePortFile(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const pathImpl = platform === 'win32' ? win32 : posix;
  return (
    options.portFile ||
    env.ANTIGRAVITY_CDP_PORT_FILE ||
    env.AGY_BROWSER_ACTIVE_PORT_FILE ||
    pathImpl.join(resolveAntigravityUserDataDirectory(options), 'DevToolsActivePort')
  );
}

export function normalizeTranslatorModelId(rawModelSpec) {
  if (typeof rawModelSpec !== 'string' || !rawModelSpec.trim()) {
    return DEFAULT_TRANSLATOR_MODEL;
  }
  const trimmed = rawModelSpec.trim();
  if (trimmed.toLowerCase().startsWith('magpie/')) {
    const stripped = trimmed.slice('magpie/'.length).trim();
    return stripped || DEFAULT_TRANSLATOR_MODEL;
  }
  return trimmed;
}

export function normalizeBaseUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return DEFAULT_MAGPIE_BASE_URL;
  }
  let cleaned = rawUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = `http://${cleaned}`;
  }
  if (!/\/v\d+$/i.test(cleaned)) {
    cleaned = `${cleaned}/v1`;
  }
  return cleaned;
}

export function discoverLocalMagpieDefaults({ home = homedir() } = {}) {
  let discoveredBaseUrl = DEFAULT_MAGPIE_BASE_URL;
  let discoveredApiKey = DEFAULT_MAGPIE_API_KEY;
  let discoveredModel = DEFAULT_TRANSLATOR_MODEL;
  let discoveredThinking = DEFAULT_TRANSLATOR_THINKING_LEVEL;

  const piModelsPath = join(home, '.pi', 'agent', 'models.json');
  if (existsSync(piModelsPath)) {
    try {
      const parsedModels = JSON.parse(readFileSync(piModelsPath, 'utf8'));
      const magpieProvider = parsedModels?.providers?.magpie;
      if (typeof magpieProvider?.baseUrl === 'string' && magpieProvider.baseUrl.trim()) {
        discoveredBaseUrl = normalizeBaseUrl(magpieProvider.baseUrl);
      }
      if (typeof magpieProvider?.apiKey === 'string' && magpieProvider.apiKey.trim()) {
        discoveredApiKey = magpieProvider.apiKey.trim();
      }
    } catch {
      // Ignore malformed external config and fall back safely.
    }
  }

  const magpieGatewayPath = join(home, '.config', 'magpie', 'gateway.json');
  if (existsSync(magpieGatewayPath)) {
    try {
      const gatewayInfo = JSON.parse(readFileSync(magpieGatewayPath, 'utf8'));
      if (typeof gatewayInfo?.addr === 'string' && gatewayInfo.addr.trim()) {
        discoveredBaseUrl = normalizeBaseUrl(gatewayInfo.addr);
      }
    } catch {
      // Ignore malformed gateway state.
    }
  }

  const piTranslatorPath = join(home, '.pi', 'agent', 'thinking-translator.json');
  if (existsSync(piTranslatorPath)) {
    try {
      const piTranslator = JSON.parse(readFileSync(piTranslatorPath, 'utf8'));
      if (typeof piTranslator?.translatorModel === 'string' && piTranslator.translatorModel.trim()) {
        discoveredModel = normalizeTranslatorModelId(piTranslator.translatorModel);
      }
      if (
        typeof piTranslator?.translatorThinking === 'string' &&
        VALID_THINKING_LEVELS.includes(piTranslator.translatorThinking)
      ) {
        discoveredThinking = piTranslator.translatorThinking;
      }
    } catch {
      // Ignore malformed external config.
    }
  }

  return {
    baseUrl: discoveredBaseUrl,
    apiKey: discoveredApiKey,
    translatorModel: discoveredModel,
    translatorThinking: discoveredThinking
  };
}

export function writeJsonAtomically(filePath, dataObject) {
  assert.equal(typeof filePath, 'string', 'filePath must be a string');
  mkdirSync(dirname(filePath), { recursive: true });
  const tempFilePath = join(dirname(filePath), `.tmp-${randomUUID()}.json`);
  try {
    writeFileSync(tempFilePath, `${JSON.stringify(dataObject, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    renameSync(tempFilePath, filePath);
  } finally {
    if (existsSync(tempFilePath)) {
      try {
        unlinkSync(tempFilePath);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

export function sanitizeSettings(rawSettings = {}, defaults) {
  const baseDefaults = defaults || {
    enabled: true,
    expandEnglishWhileThinking: true,
    collapseEnglishWhenDone: true,
    keepChineseExpanded: true,
    keepContainersExpanded: true,
    forceVerboseSteps: true,
    baseUrl: DEFAULT_MAGPIE_BASE_URL,
    apiKey: DEFAULT_MAGPIE_API_KEY,
    translatorModel: DEFAULT_TRANSLATOR_MODEL,
    translatorThinking: DEFAULT_TRANSLATOR_THINKING_LEVEL,
    excludedModels: []
  };

  return {
    enabled: typeof rawSettings.enabled === 'boolean' ? rawSettings.enabled : baseDefaults.enabled,
    expandEnglishWhileThinking:
      typeof rawSettings.expandEnglishWhileThinking === 'boolean'
        ? rawSettings.expandEnglishWhileThinking
        : baseDefaults.expandEnglishWhileThinking,
    collapseEnglishWhenDone:
      typeof rawSettings.collapseEnglishWhenDone === 'boolean'
        ? rawSettings.collapseEnglishWhenDone
        : baseDefaults.collapseEnglishWhenDone,
    keepChineseExpanded:
      typeof rawSettings.keepChineseExpanded === 'boolean'
        ? rawSettings.keepChineseExpanded
        : baseDefaults.keepChineseExpanded,
    keepContainersExpanded:
      typeof rawSettings.keepContainersExpanded === 'boolean'
        ? rawSettings.keepContainersExpanded
        : baseDefaults.keepContainersExpanded,
    forceVerboseSteps:
      typeof rawSettings.forceVerboseSteps === 'boolean'
        ? rawSettings.forceVerboseSteps
        : baseDefaults.forceVerboseSteps,
    baseUrl:
      typeof rawSettings.baseUrl === 'string' && rawSettings.baseUrl.trim()
        ? normalizeBaseUrl(rawSettings.baseUrl)
        : baseDefaults.baseUrl,
    apiKey:
      typeof rawSettings.apiKey === 'string' && rawSettings.apiKey.trim()
        ? rawSettings.apiKey.trim()
        : baseDefaults.apiKey,
    translatorModel:
      typeof rawSettings.translatorModel === 'string' && rawSettings.translatorModel.trim()
        ? normalizeTranslatorModelId(rawSettings.translatorModel)
        : baseDefaults.translatorModel,
    translatorThinking:
      typeof rawSettings.translatorThinking === 'string' &&
      VALID_THINKING_LEVELS.includes(rawSettings.translatorThinking)
        ? rawSettings.translatorThinking
        : baseDefaults.translatorThinking,
    excludedModels: Array.isArray(rawSettings.excludedModels)
      ? rawSettings.excludedModels
          .filter(item => typeof item === 'string' && item.trim().length > 0)
          .map(item => item.trim())
      : [...baseDefaults.excludedModels]
  };
}

export function createSettingsStore({ dataDirectory = resolvePluginDataDirectory(), home = homedir() } = {}) {
  const settingsFilePath = join(dataDirectory, 'settings.json');
  const discovered = discoverLocalMagpieDefaults({ home });
  const defaultSettings = sanitizeSettings({}, {
    enabled: true,
    expandEnglishWhileThinking: true,
    collapseEnglishWhenDone: true,
    keepChineseExpanded: true,
    keepContainersExpanded: true,
    forceVerboseSteps: true,
    baseUrl: discovered.baseUrl,
    apiKey: discovered.apiKey,
    translatorModel: discovered.translatorModel,
    translatorThinking: discovered.translatorThinking,
    excludedModels: []
  });

  let cachedSettings = null;

  function loadFromDisk() {
    if (!existsSync(settingsFilePath)) {
      cachedSettings = { ...defaultSettings };
      return cachedSettings;
    }
    try {
      const parsed = JSON.parse(readFileSync(settingsFilePath, 'utf8'));
      cachedSettings = sanitizeSettings(parsed, defaultSettings);
      return cachedSettings;
    } catch {
      cachedSettings = { ...defaultSettings };
      return cachedSettings;
    }
  }

  return {
    settingsFilePath,
    defaults: defaultSettings,
    get() {
      if (!cachedSettings) return { ...loadFromDisk() };
      return { ...cachedSettings };
    },
    set(partialPatch = {}) {
      const current = cachedSettings || loadFromDisk();
      const next = sanitizeSettings({ ...current, ...partialPatch }, defaultSettings);
      cachedSettings = next;
      writeJsonAtomically(settingsFilePath, next);
      return { ...next };
    },
    reset() {
      cachedSettings = { ...defaultSettings };
      writeJsonAtomically(settingsFilePath, cachedSettings);
      return { ...cachedSettings };
    }
  };
}
