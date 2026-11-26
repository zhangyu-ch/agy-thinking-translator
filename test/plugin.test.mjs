import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  computeParagraphKey,
  shouldTranslateThinking,
  splitThinkingParagraphs
} from '../lib/text-splitter.mjs';
import {
  createSettingsStore,
  discoverLocalMagpieDefaults,
  normalizeBaseUrl,
  normalizeTranslatorModelId
} from '../lib/settings.mjs';
import { createTranslationCache } from '../lib/cache.mjs';
import { createTranslatorService } from '../lib/translator.mjs';
import {
  buildInjectedScript,
  isAntigravityHubTarget,
  isPowertoolsEnabled,
  parseNativeHookNamesFromSource
} from '../lib/cdp-host.mjs';
import { installPluginPackage, uninstallPluginPackage } from '../lib/installer.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('splitThinkingParagraphs preserves code fences and merges standalone headings', () => {
  const input = [
    '### Step 1: Analyze',
    '',
    'First paragraph checking the layout.',
    '',
    '```python',
    'def compute():',
    '',
    '    return 42',
    '```',
    '',
    'Final conclusion paragraph.'
  ].join('\n');

  const parts = splitThinkingParagraphs(input);
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^### Step 1: Analyze\n\nFirst paragraph/);
  assert.match(parts[1], /^```python\ndef compute\(\):\n\n    return 42\n```$/);
  assert.equal(parts[2], 'Final conclusion paragraph.');
});

test('shouldTranslateThinking accepts English reasoning and skips Chinese or code-only blocks', () => {
  assert.equal(
    shouldTranslateThinking('We need to inspect `plugin.json` and check how sidecars start.'),
    true
  );
  assert.equal(shouldTranslateThinking('```js\nconst x = 1;\n```'), false);
  assert.equal(shouldTranslateThinking('`only_inline_code`'), false);
  assert.equal(
    shouldTranslateThinking(
      '比较这两个拉伸步骤时，SolidWorks 的反向拉伸所增加的体积大约是 FreeCAD 版本的四倍。'
    ),
    false
  );
});

test('client-injected sha256Key32 matches server computeParagraphKey across Unicode inputs', () => {
  const clientSource = readFileSync(join(PLUGIN_ROOT, 'lib', 'client-injected.js'), 'utf8');
  const fnMatch = clientSource.match(
    /const SHA256_K = new Uint32Array\([\s\S]*?function sha256Key32\(inputText\) \{[\s\S]*?\n  \}/
  );
  assert.ok(fnMatch, 'sha256Key32 source must exist in client-injected.js');

  const sandbox = { TextEncoder, Uint32Array, Uint8Array, DataView, Math };
  vm.runInNewContext(`${fnMatch[0]}\nglobalThis.testSha256 = sha256Key32;`, sandbox);

  const samples = [
    'Short ASCII paragraph.',
    'Multi-line\nthinking with `code` and 🚀 unicode symbols.',
    'Mixed CJK 思维链测试 with Pad018 and 1.112 mm²!',
    'A'.repeat(4096) + ' tail'
  ];

  for (const sample of samples) {
    assert.equal(sandbox.testSha256(sample), computeParagraphKey(sample));
  }
});

test('discoverLocalMagpieDefaults and settings normalization handle magpie prefix and gateway.json', () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'agy-tt-home-'));
  try {
    mkdirSync(join(tempHome, '.pi', 'agent'), { recursive: true });
    mkdirSync(join(tempHome, '.config', 'magpie'), { recursive: true });

    writeFileSync(
      join(tempHome, '.pi', 'agent', 'models.json'),
      JSON.stringify({
        providers: {
          magpie: { baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'magpie-custom' }
        }
      })
    );
    writeFileSync(
      join(tempHome, '.config', 'magpie', 'gateway.json'),
      JSON.stringify({ addr: '127.0.0.1:3425' })
    );
    writeFileSync(
      join(tempHome, '.pi', 'agent', 'thinking-translator.json'),
      JSON.stringify({ translatorModel: 'magpie/group/ds-flash', translatorThinking: 'low' })
    );

    const discovered = discoverLocalMagpieDefaults({ home: tempHome });
    assert.equal(discovered.baseUrl, 'http://127.0.0.1:3425/v1');
    assert.equal(discovered.apiKey, 'magpie-custom');
    assert.equal(discovered.translatorModel, 'group/ds-flash');
    assert.equal(discovered.translatorThinking, 'low');

    assert.equal(normalizeTranslatorModelId('magpie/group/ds-flash'), 'group/ds-flash');
    assert.equal(normalizeBaseUrl('127.0.0.1:3425'), 'http://127.0.0.1:3425/v1');
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('translator streams SSE deltas, ignores reasoning_content, retries transient errors, and persists cache', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'agy-tt-trans-'));
  let requestCounter = 0;
  let receivedBodies = [];

  const mockServer = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', c => {
      raw += c;
    });
    req.on('end', () => {
      requestCounter++;
      receivedBodies.push(JSON.parse(raw));

      if (requestCounter === 1) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Upstream temporary gateway error');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'ignore internal thought' } }] })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '<think>hidden</think>正在检查插件目录' } }] })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '并验证流式翻译。' } }] })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise(resolvePromise => mockServer.listen(0, '127.0.0.1', resolvePromise));
  const port = mockServer.address().port;

  try {
    const settingsStore = createSettingsStore({ dataDirectory: tempDir, home: tempDir });
    settingsStore.set({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'magpie',
      translatorModel: 'magpie/group/ds-flash',
      translatorThinking: 'low'
    });

    const cache = createTranslationCache({ dataDirectory: tempDir, persistDebounceMs: 0 });
    const observedEvents = [];
    const translator = createTranslatorService({
      settingsStore,
      cache,
      retryCount: 1,
      retryDelayMs: 30,
      onUpdate: ev => observedEvents.push(ev)
    });

    const source = 'Checking the plugin directory and verifying streaming translation.';
    const res1 = await translator.translateParagraph(source);
    assert.equal(res1.status, 'done');
    assert.equal(res1.translation, '正在检查插件目录并验证流式翻译。');
    assert.equal(requestCounter, 2, 'Should retry once after initial 502');
    assert.equal(receivedBodies[0].model, 'group/ds-flash');
    assert.equal(receivedBodies[0].reasoning_effort, 'low');
    assert.ok(observedEvents.some(e => e.status === 'streaming' && e.translation === '正在检查插件目录'));

    // Second call hits cache without making an HTTP request
    const res2 = await translator.translateParagraph(source);
    assert.equal(res2.cached, true);
    assert.equal(res2.translation, '正在检查插件目录并验证流式翻译。');
    assert.equal(requestCounter, 2);

    // Reload cache from disk and verify persistence
    const reloadedCache = createTranslationCache({ dataDirectory: tempDir, persistDebounceMs: 0 });
    assert.equal(reloadedCache.get(source), '正在检查插件目录并验证流式翻译。');
  } finally {
    await new Promise(resolvePromise => mockServer.close(resolvePromise));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('parseNativeHookNamesFromSource and isAntigravityHubTarget match real bundle patterns', () => {
  const sampleBundle = `
    var iB=(0,D.createContext)(null),E3a=({children:a,cascadeContext:b,workspaceInfo:c,verboseAgentChat:k})=>a;
    function lNc(a){var {segment:b,isRunning:c,getStepRendererConfig:g,hasBeenCollapsed:k}=a;return {leadingSteps:[]};}
  `;
  const hooks = parseNativeHookNamesFromSource(sampleBundle);
  assert.equal(hooks.segmentName, 'lNc');
  assert.equal(hooks.providerName, 'E3a');

  assert.equal(
    isAntigravityHubTarget({
      type: 'page',
      title: '0-anti - Antigravity',
      url: 'https://127.0.0.1:51234/c/abc-123'
    }),
    true
  );
  assert.equal(
    isAntigravityHubTarget({
      type: 'page',
      title: '(2) Project - Antigravity (WSL: Ubuntu)',
      url: 'https://localhost:51234/c/abc-123'
    }),
    true
  );
  assert.equal(
    isAntigravityHubTarget({
      type: 'page',
      title: 'External Site',
      url: 'https://example.com'
    }),
    false
  );
});

test('installer copies verified files without touching config.json and uninstalls cleanly', async () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'agy-tt-install-'));
  try {
    const installRes = await installPluginPackage({
      sourceRoot: PLUGIN_ROOT,
      home: tempHome,
      startSidecarIfNeeded: false
    });

    assert.equal(installRes.pluginId, 'agy-thinking-translator');
    assert.ok(existsSync(join(installRes.destination, 'plugin.json')));
    assert.ok(existsSync(join(installRes.destination, 'sidecars', 'translator', 'sidecar.json')));
    assert.ok(existsSync(join(installRes.destination, '.install-receipt.json')));
    assert.equal(
      existsSync(join(tempHome, '.gemini', 'config', 'config.json')),
      false,
      'Installer must never create or modify ~/.gemini/config/config.json'
    );

    const uninstallRes = await uninstallPluginPackage({ home: tempHome, keepSettings: false });
    assert.equal(uninstallRes.removed, true);
    assert.equal(existsSync(installRes.destination), false);
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('isPowertoolsEnabled and client-injected yield/self-heal segment hook for agy-powertools coexistence', async () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'agy-tt-coexist-'));
  try {
    assert.equal(isPowertoolsEnabled({ home: tempHome }), false);
    mkdirSync(join(tempHome, '.gemini', 'config'), { recursive: true });
    writeFileSync(
      join(tempHome, '.gemini', 'config', 'config.json'),
      JSON.stringify({ plugins: { 'agy-powertools': { enabled: true } } })
    );
    assert.equal(isPowertoolsEnabled({ home: tempHome }), true);
    writeFileSync(
      join(tempHome, '.gemini', 'config', 'config.json'),
      JSON.stringify({ plugins: { 'agy-powertools': { enabled: false } } })
    );
    assert.equal(isPowertoolsEnabled({ home: tempHome }), false);
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }

  function createDomSandbox(origin) {
    const headChildren = [];
    const styleNode = {
      id: '',
      textContent: '',
      isConnected: false,
      remove() {
        this.isConnected = false;
      }
    };
    const document = {
      head: {
        appendChild(el) {
          el.isConnected = true;
          headChildren.push(el);
          return el;
        }
      },
      body: {},
      documentElement: {},
      createElement() {
        return { ...styleNode, dataset: {}, classList: { add() {}, remove() {} }, style: {} };
      },
      getElementById() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      addEventListener() {}
    };
    class MockMutationObserver {
      observe() {}
      disconnect() {}
    }
    const sandbox = {
      location: { origin },
      document,
      MutationObserver: MockMutationObserver,
      AbortController,
      TextEncoder,
      Uint32Array,
      Uint8Array,
      DataView,
      Math,
      Date,
      Function,
      Object,
      Map,
      Set,
      WeakSet,
      Promise,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      requestAnimationFrame: fn => setTimeout(fn, 0)
    };
    sandbox.window = sandbox;
    sandbox.top = sandbox;
    sandbox.globalThis = sandbox;
    return sandbox;
  }

  const origin = 'https://127.0.0.1:54321';
  const defaultSettings = {
    enabled: true,
    expandEnglishWhileThinking: true,
    collapseEnglishWhenDone: true,
    keepChineseExpanded: true,
    keepContainersExpanded: true,
    forceVerboseSteps: true,
    translatorModel: 'group/ds-flash',
    translatorThinking: 'low',
    excludedModels: []
  };

  // 1. Cold-start courtesy + hot-reload self-healing when agy-powertools is enabled
  const sandbox = createDomSandbox(origin);
  sandbox.mVc = vm.runInContext(
    '(function mVc(a){var {getStepRendererConfig:g,hasBeenCollapsed:k}=a;return {leadingSteps:[],body:{type:"inline"},seenVerbose:Boolean(a?.verboseAgentChat)};})',
    vm.createContext({})
  );
  const originalNativeMvc = sandbox.mVc;
  sandbox.E3a = props => props;

  const script = buildInjectedScript({
    origin,
    settings: defaultSettings,
    nativeHooks: { segmentName: 'mVc', providerName: 'E3a' },
    coexistWithPowertools: true,
    powertoolsYieldMaxMs: 2000
  });
  vm.runInNewContext(script, sandbox);

  try {
    // Immediately after injection (before Powertools boots), mVc MUST remain unwrapped so Powertools can inspect Function.prototype.toString
    assert.equal(sandbox.mVc, originalNativeMvc);
    assert.equal(Boolean(sandbox.mVc.__agyTTWrapped), false);
    assert.equal(Boolean(sandbox.E3a.__agyTTWrapped), true, 'Provider can wrap immediately');

    // Simulate Powertools resolving native mVc, wrapping it with stageSegmentRender, and mounting
    const powertoolsStageWrapper = function (...args) {
      const res = originalNativeMvc(...args);
      return { ...res, fromPowertools: true };
    };
    sandbox.mVc = powertoolsStageWrapper;
    sandbox.__agyPowertools = { status: { healthy: true, mounted: 1 } };

    await new Promise(r => setTimeout(r, 320));
    assert.equal(Boolean(sandbox.mVc.__agyTTWrapped), true, 'Should wrap on top once Powertools is healthy');
    const combinedOut = sandbox.mVc({ getStepRendererConfig: () => ({}), hasBeenCollapsed: false, segment: { steps: [] } });
    assert.equal(combinedOut.fromPowertools, true);
    assert.equal(combinedOut.seenVerbose, true);

    // Simulate Powertools hot-reload: Powertools disposes (deleting __agyPowertools) while mVc is wrapped by TT
    delete sandbox.__agyPowertools;
    sandbox.__agyCompatibilityError = 'Antigravity compatibility: segment (missing)';
    sandbox.__agyThinkingTranslator.sync();

    assert.equal(sandbox.mVc, originalNativeMvc, 'Must self-heal back to root native mVc on Powertools hot-reload');
    assert.equal(sandbox.__agyCompatibilityError, undefined, 'Must clear stale compatibility error');

    // Powertools remounts cleanly on restored native mVc, and TT re-wraps on top
    const powertoolsStageWrapperV2 = function (...args) {
      return { ...originalNativeMvc(...args), fromPowertoolsV2: true };
    };
    sandbox.mVc = powertoolsStageWrapperV2;
    sandbox.__agyPowertools = { status: { healthy: true, mounted: 1 } };
    await new Promise(r => setTimeout(r, 320));
    assert.equal(Boolean(sandbox.mVc.__agyTTWrapped), true);
    assert.equal(sandbox.mVc({ getStepRendererConfig: () => ({}), hasBeenCollapsed: false, segment: { steps: [] } }).fromPowertoolsV2, true);
  } finally {
    sandbox.__agyThinkingTranslator?.dispose?.();
  }

  // 2. Bounded grace timeout fallback if Powertools is enabled in config.json but never mounts
  const fallbackSandbox = createDomSandbox(origin);
  fallbackSandbox.mVc = originalNativeMvc;
  const shortScript = buildInjectedScript({
    origin,
    settings: defaultSettings,
    nativeHooks: { segmentName: 'mVc', providerName: null },
    coexistWithPowertools: true,
    powertoolsYieldMaxMs: 120
  });
  vm.runInNewContext(shortScript, fallbackSandbox);
  try {
    assert.equal(Boolean(fallbackSandbox.mVc.__agyTTWrapped), false);
    await new Promise(r => setTimeout(r, 380));
    assert.equal(Boolean(fallbackSandbox.mVc.__agyTTWrapped), true, 'Must wrap after grace window expires');
  } finally {
    fallbackSandbox.__agyThinkingTranslator?.dispose?.();
  }
});
