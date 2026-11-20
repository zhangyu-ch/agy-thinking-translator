export const PLUGIN_ID = 'agy-thinking-translator';
export const PLUGIN_DISPLAY_NAME = 'Thinking Translator';
export const PLUGIN_VERSION = '1.0.0';

export const DEFAULT_MAGPIE_BASE_URL = 'http://127.0.0.1:3425/v1';
export const DEFAULT_MAGPIE_API_KEY = 'magpie';
export const DEFAULT_TRANSLATOR_MODEL = 'group/ds-flash';
export const DEFAULT_TRANSLATOR_THINKING_LEVEL = 'low';

export const VALID_THINKING_LEVELS = Object.freeze([
  'low',
  'minimal',
  'off',
  'medium',
  'high',
  'xhigh',
  'max'
]);

export const MAX_CONCURRENT_TRANSLATIONS = 4;
export const TRANSLATION_REQUEST_TIMEOUT_MS = 60_000;
export const TRANSLATION_RETRY_COUNT = 1;
export const TRANSLATION_RETRY_DELAY_MS = 1_200;
export const MAX_SOURCE_PARAGRAPH_LENGTH = 16_000;

export const MAX_MEMORY_CACHE_ENTRIES = 2_000;
export const MAX_DISK_CACHE_ENTRIES = 5_000;
export const CACHE_PERSIST_DEBOUNCE_MS = 800;

export const CDP_CONNECT_TIMEOUT_MS = 4_000;
export const CDP_POLL_INTERVAL_MS = 3_500;
export const CDP_COMMAND_TIMEOUT_MS = 6_000;
export const CDP_EVALUATE_TIMEOUT_MS = 15_000;
export const CDP_MAX_BINDING_PAYLOAD_BYTES = 131_072;

export const HOST_BINDING_NAME = '__agyThinkingTranslatorHost';
export const CLIENT_RECEIVE_GLOBAL = '__agyThinkingTranslatorReceive';
export const CLIENT_PUSH_GLOBAL = '__agyThinkingTranslatorPush';
export const CLIENT_INSTANCE_GLOBAL = '__agyThinkingTranslator';

export const CJK_SKIP_RATIO_THRESHOLD = 0.22;

export const TRANSLATION_SYSTEM_PROMPT =
  'You are a professional technical translator. Translate the following AI thinking process (chain-of-thought) from English into concise, natural Chinese. Keep Markdown formatting, code blocks, identifiers, file paths, command flags, and technical terms intact. Output ONLY the translated Chinese text without any preamble, notes, or explanation.';
