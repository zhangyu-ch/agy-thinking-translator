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
import { isAntigravityHubTarget, parseNativeHookNamesFromSource } from '../lib/cdp-host.mjs';
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
