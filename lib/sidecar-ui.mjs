import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VALID_THINKING_LEVELS } from './constants.mjs';

function findSidecarPreloadJs(env = process.env) {
  const candidates = [
    env.ANTIGRAVITY_APP_DATA_DIR &&
      join(env.ANTIGRAVITY_APP_DATA_DIR, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
    join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js')
  ].filter(Boolean);
  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      try {
        return readFileSync(filePath, 'utf8');
      } catch {}
    }
  }
  return '';
}

function readJsonBody(req, maxBytes = 32_768) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
        req.destroy(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function renderSidecarAuxHtml({ version }) {
  const levelsJson = JSON.stringify(VALID_THINKING_LEVELS);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>思维链翻译 (Thinking Translator)</title>
  <script src="/preload.js"></script>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 14px;
      background: var(--background, #0d1117);
      color: var(--foreground, #e6edf3);
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .stack { display: flex; flex-direction: column; gap: 12px; }
    .card {
      border: 1px solid var(--border, rgba(127, 127, 127, 0.24));
      background: var(--card, rgba(127, 127, 127, 0.06));
      border-radius: 10px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .card-title {
      font-size: 13px;
      font-weight: 600;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .status-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      gap: 8px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 500;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #f59e0b;
    }
    .dot[data-ok="true"] { background: #16a34a; }
    .muted { color: var(--muted-foreground, #8b949e); font-size: 11.5px; }
    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 4px 0;
    }
    .toggle-label { display: flex; flex-direction: column; gap: 2px; }
    .toggle-label span { font-size: 12.5px; font-weight: 500; }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .field label { font-size: 12px; font-weight: 500; }
    input[type="text"], select {
      width: 100%;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
      background: var(--secondary, rgba(127, 127, 127, 0.12));
      color: var(--foreground, inherit);
      font: inherit;
    }
    .btn-row { display: flex; flex-wrap: wrap; gap: 8px; }
    button {
      appearance: none;
      border: 1px solid transparent;
      border-radius: 7px;
      padding: 6px 11px;
      font: 500 12px/1.3 inherit;
      cursor: pointer;
      background: var(--primary, #2563eb);
      color: var(--primary-foreground, #fff);
    }
    button.secondary {
      background: var(--secondary, rgba(127, 127, 127, 0.15));
      color: var(--foreground, inherit);
      border-color: var(--border, rgba(127, 127, 127, 0.25));
    }
    button:disabled { opacity: 0.55; cursor: default; }
    .notice {
      font-size: 12px;
      padding: 7px 9px;
      border-radius: 6px;
      background: var(--secondary, rgba(127, 127, 127, 0.14));
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="stack">
    <section class="card">
      <h2 class="card-title">
        <span>思维链中文翻译</span>
        <span class="muted">v${version}</span>
      </h2>
      <div class="status-row">
        <span class="muted">聊天界面接入</span>
        <span class="badge"><span class="dot" id="ui-dot"></span><span id="ui-status">检测中…</span></span>
      </div>
      <div class="status-row">
        <span class="muted">Magpie 翻译网关</span>
        <span class="badge"><span class="dot" id="gw-dot"></span><span id="gw-status">检测中…</span></span>
      </div>
      <div class="status-row">
        <span class="muted">持久化译文缓存</span>
        <span id="cache-status" class="muted">0 段</span>
      </div>
      <div class="btn-row">
        <button type="button" id="test-btn">测试 DS Flash 翻译</button>
        <button type="button" id="start-magpie-btn" class="secondary" hidden>启动本机 Magpie</button>
        <button type="button" id="clear-cache-btn" class="secondary">清空缓存</button>
      </div>
      <div id="feedback" class="notice" hidden></div>
    </section>

    <section class="card">
      <h2 class="card-title">展开与显示策略</h2>
      <label class="toggle-row">
        <div class="toggle-label">
          <span>启用插件</span>
          <small class="muted">总开关：实时作用于所有打开的会话窗口</small>
        </div>
        <input type="checkbox" id="opt-enabled" />
      </label>
      <label class="toggle-row">
        <div class="toggle-label">
          <span>思考过程中保持英文展开</span>
          <small class="muted">模型正在思考时自动展开原英文思维链</small>
        </div>
        <input type="checkbox" id="opt-expandEnglishWhileThinking" />
      </label>
      <label class="toggle-row">
        <div class="toggle-label">
          <span>思考完成后自动收起英文</span>
          <small class="muted">思考结束后折叠英文原文，仅保留下方中文译文展开</small>
        </div>
        <input type="checkbox" id="opt-collapseEnglishWhenDone" />
      </label>
      <label class="toggle-row">
        <div class="toggle-label">
          <span>中文思维链常驻展开</span>
          <small class="muted">在 Thought for Xs 正下方始终展开显示中文译文</small>
        </div>
        <input type="checkbox" id="opt-keepChineseExpanded" />
      </label>
      <label class="toggle-row">
        <div class="toggle-label">
          <span>保持外层步骤/用时折叠栏展开</span>
          <small class="muted">防止整轮结束后外层「用时 / 工具组」折叠隐藏中文思维链</small>
        </div>
        <input type="checkbox" id="opt-keepContainersExpanded" />
      </label>
    </section>

    <section class="card">
      <h2 class="card-title">翻译模型配置 (Magpie)</h2>
      <div class="field">
        <label for="inp-baseUrl">本地网关地址 (OpenAI 兼容)</label>
        <input type="text" id="inp-baseUrl" placeholder="http://127.0.0.1:3425/v1" />
      </div>
      <div class="field">
        <label for="inp-translatorModel">模型 ID</label>
        <input type="text" id="inp-translatorModel" placeholder="group/ds-flash" />
      </div>
      <div class="field">
        <label for="sel-translatorThinking">思考等级 (Thinking Level)</label>
        <select id="sel-translatorThinking"></select>
      </div>
      <div class="btn-row">
        <button type="button" id="save-model-btn">保存模型配置</button>
      </div>
    </section>
  </div>

  <script>
    (() => {
      const token = new URLSearchParams(location.search).get('token') || '';
      const levels = ${levelsJson};
      const selectEl = document.getElementById('sel-translatorThinking');
      for (const lv of levels) {
        const opt = document.createElement('option');
        opt.value = lv;
        opt.textContent = lv;
        selectEl.appendChild(opt);
      }

      const apiUrl = path => path + (token ? '?token=' + encodeURIComponent(token) : '');
      const headers = () => {
        const h = { 'Content-Type': 'application/json' };
        if (token) h['x-sidecar-token'] = token;
        return h;
      };

      const feedback = document.getElementById('feedback');
      function showFeedback(text) {
        feedback.hidden = !text;
        feedback.textContent = text || '';
      }

      const checkboxKeys = [
        'enabled',
        'expandEnglishWhileThinking',
        'collapseEnglishWhenDone',
        'keepChineseExpanded',
        'keepContainersExpanded'
      ];

      let initializedInputs = false;

      function renderState(data) {
        const uiDot = document.getElementById('ui-dot');
        const uiStatus = document.getElementById('ui-status');
        uiDot.dataset.ok = String(Boolean(data.ui?.healthy));
        uiStatus.textContent = data.ui?.healthy
          ? '已连接 (' + (data.ui.attachedWindows || 1) + ' 窗口 · ' + (data.ui.renderedBlocks || 0) + ' 处译文)'
          : (data.ui?.lastStatus || '等待窗口');

        const gwDot = document.getElementById('gw-dot');
        const gwStatus = document.getElementById('gw-status');
        gwDot.dataset.ok = String(Boolean(data.gateway?.online));
        gwStatus.textContent = data.gateway?.online
          ? '在线 (' + data.settings.translatorModel + ')'
          : '未连接 (' + (data.gateway?.error || '请启动 Magpie') + ')';

        document.getElementById('start-magpie-btn').hidden = Boolean(data.gateway?.online) || !data.magpieInstalled;
        document.getElementById('cache-status').textContent =
          (data.metrics?.totalCachedParagraphs || 0) + ' 段已缓存';

        if (data.settings) {
          for (const k of checkboxKeys) {
            const el = document.getElementById('opt-' + k);
            if (el) el.checked = Boolean(data.settings[k]);
          }
          if (!initializedInputs) {
            initializedInputs = true;
            document.getElementById('inp-baseUrl').value = data.settings.baseUrl || '';
            document.getElementById('inp-translatorModel').value = data.settings.translatorModel || '';
            selectEl.value = data.settings.translatorThinking || 'low';
          }
        }
      }

      async function refreshStatus() {
        try {
          const res = await fetch(apiUrl('/api/status'), { headers: headers() });
          if (res.ok) renderState(await res.json());
        } catch {}
      }

      for (const k of checkboxKeys) {
        document.getElementById('opt-' + k).addEventListener('change', async ev => {
          await fetch(apiUrl('/api/settings'), {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ [k]: ev.target.checked })
          });
          await refreshStatus();
        });
      }

      document.getElementById('save-model-btn').addEventListener('click', async () => {
        const patch = {
          baseUrl: document.getElementById('inp-baseUrl').value.trim(),
          translatorModel: document.getElementById('inp-translatorModel').value.trim(),
          translatorThinking: selectEl.value
        };
        const res = await fetch(apiUrl('/api/settings'), {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(patch)
        });
        if (res.ok) {
          showFeedback('已保存模型配置并同步至会话窗口。');
          await refreshStatus();
        }
      });

      document.getElementById('test-btn').addEventListener('click', async ev => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        showFeedback('正在通过 Magpie 调用 DS Flash 测试翻译…');
        try {
          const res = await fetch(apiUrl('/api/test-translate'), {
            method: 'POST',
            headers: headers(),
            body: '{}'
          });
          const data = await res.json();
          if (data.ok) {
            showFeedback('翻译成功 (' + data.elapsedMs + 'ms)：' + data.translation);
          } else {
            showFeedback('测试失败：' + (data.error || '未知错误'));
          }
        } catch (err) {
          showFeedback('请求异常：' + err.message);
        } finally {
          btn.disabled = false;
          await refreshStatus();
        }
      });

      document.getElementById('start-magpie-btn').addEventListener('click', async ev => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        showFeedback('正在后台启动 Magpie 托盘网关…');
        try {
          const res = await fetch(apiUrl('/api/start-magpie'), {
            method: 'POST',
            headers: headers(),
            body: '{}'
          });
          const data = await res.json();
          showFeedback(data.started ? '已启动 Magpie，正在检测网关就绪状态…' : ('启动失败：' + data.error));
          setTimeout(refreshStatus, 2000);
        } finally {
          btn.disabled = false;
        }
      });

      document.getElementById('clear-cache-btn').addEventListener('click', async () => {
        await fetch(apiUrl('/api/clear-cache'), {
          method: 'POST',
          headers: headers(),
          body: '{}'
        });
        showFeedback('已清空持久化翻译缓存。');
        await refreshStatus();
      });

      void refreshStatus();
      setInterval(refreshStatus, 3500);
    })();
  </script>
</body>
</html>`;
}

export function startSidecarAuxServer({
  port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0),
  token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '',
  version,
  getStatus,
  updateSettings,
  testTranslate,
  startMagpie,
  clearCache,
  env = process.env
}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return Promise.resolve(async () => {});
  }

  const preloadScript = findSidecarPreloadJs(env);
  const isAuthorized = (req, parsedUrl) => {
    if (parsedUrl.pathname === '/preload.js') return true;
    if (!token) return true;
    return (req.headers['x-sidecar-token'] || parsedUrl.searchParams.get('token')) === token;
  };

  const server = createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && parsedUrl.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(preloadScript);
      return;
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderSidecarAuxHtml({ version }));
      return;
    }
    if (!isAuthorized(req, parsedUrl)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    try {
      if (req.method === 'GET' && parsedUrl.pathname === '/api/status') {
        const status = await getStatus();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(status));
        return;
      }
      if (req.method === 'POST' && parsedUrl.pathname === '/api/settings') {
        const patch = await readJsonBody(req);
        const updated = await updateSettings(patch);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, settings: updated }));
        return;
      }
      if (req.method === 'POST' && parsedUrl.pathname === '/api/test-translate') {
        const result = await testTranslate();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method === 'POST' && parsedUrl.pathname === '/api/start-magpie') {
        const result = await startMagpie();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method === 'POST' && parsedUrl.pathname === '/api/clear-cache') {
        await clearCache();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(() => new Promise(done => server.close(() => done())));
    });
  });
}
