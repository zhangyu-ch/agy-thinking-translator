import { createSettingsStore, resolvePluginDataDirectory } from '../../lib/settings.mjs';

export { createSettingsStore, resolvePluginDataDirectory };

export function publicSettingsView(fullSettings) {
  const { apiKey: _hidden, ...visible } = fullSettings;
  return visible;
}
