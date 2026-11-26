import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CDP_COMMAND_TIMEOUT_MS,
  CDP_CONNECT_TIMEOUT_MS,
  CDP_EVALUATE_TIMEOUT_MS,
  CDP_MAX_BINDING_PAYLOAD_BYTES,
  CDP_POLL_INTERVAL_MS,
  CLIENT_INSTANCE_GLOBAL,
  CLIENT_PUSH_GLOBAL,
  CLIENT_RECEIVE_GLOBAL,
  HOST_BINDING_NAME,
  PLUGIN_VERSION,
  POWERTOOLS_YIELD_MAX_MS
} from './constants.mjs';
import {
  resolveDevToolsActivePortFile,
  resolvePluginDataDirectory,
  writeJsonAtomically
} from './settings.mjs';

const CLIENT_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'client-injected.js');

const SEGMENT_FN_REGEX =
  /function\s+([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\)\{[^;]{0,600}?getStepRendererConfig:[^;]{0,600}?hasBeenCollapsed:/;
const PROVIDER_VAR_REGEX =
  /[,;\s]([A-Za-z_$][\w$]*)=\(\{children:[A-Za-z_$][\w$]*,cascadeContext:[A-Za-z_$][\w$]*,[^}]{0,600}?verboseAgentChat:/;

export function parseNativeHookNamesFromSource(bundleSource) {
  if (typeof bundleSource !== 'string' || !bundleSource) {
    return { segmentName: null, providerName: null };
  }
  const segmentMatch = bundleSource.match(SEGMENT_FN_REGEX);
  const providerMatch = bundleSource.match(PROVIDER_VAR_REGEX);
  return {
    segmentName: segmentMatch?.[1] || null,
    providerName: providerMatch?.[1] || null
  };
}

export function isAntigravityHubTarget(target) {
  try {
    const parsedUrl = new URL(target.url);
    return (
      target.type === 'page' &&
      /(?:^| - |\(\d+\) )Antigravity(?:\s*(?:\([^)]+\)|\[[^\]]+\]))?$/.test(target.title || '') &&
      parsedUrl.protocol === 'https:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsedUrl.hostname)
    );
  } catch {
    return false;
  }
}

function fetchLocalCdpTargets(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/json/list',
        method: 'GET',
        agent: false
      },
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`CDP HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(3_000, () => req.destroy(new Error('CDP list timeout')));
    req.on('error', reject);
    req.end();
  });
}

function fetchLocalMainBundle(originUrl) {
  const bundleUrl = new URL('/main.js', originUrl);
  if (
    bundleUrl.protocol !== 'https:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(bundleUrl.hostname)
  ) {
    return Promise.reject(new Error('Only loopback HTTPS origins are supported'));
  }
  return new Promise((resolve, reject) => {
    const req = https.get(
      bundleUrl,
      { rejectUnauthorized: false, agent: false },
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Bundle HTTP ${res.statusCode}`));
          return;
        }
        let source = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          source += chunk;
          if (source.length > 36 * 1024 * 1024) {
            req.destroy(new Error('Bundle exceeds size cap'));
          }
        });
        res.on('end', () => resolve(source));
        res.on('error', reject);
      }
    );
    req.setTimeout(6_000, () => req.destroy(new Error('Bundle read timeout')));
    req.on('error', reject);
  });
}

export function connectCdpSocket(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pendingRequests = new Map();
    const eventListeners = new Set();
    let sequence = 0;

    const connectTimer = setTimeout(() => {
      try {
        socket.close();
      } catch {}
      reject(new Error('CDP WebSocket connection timed out'));
    }, CDP_CONNECT_TIMEOUT_MS);

    const handleClose = () => {
      for (const entry of pendingRequests.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP connection closed'));
      }
      pendingRequests.clear();
    };

    socket.addEventListener('error', () => {
      clearTimeout(connectTimer);
      reject(new Error('CDP WebSocket connection error'));
    });
    socket.addEventListener('close', handleClose);
    socket.addEventListener('message', event => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const pending = pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || 'CDP error'));
        } else {
          pending.resolve(message.result);
        }
      } else {
        for (const listener of eventListeners) {
          listener(message);
        }
      }
    });

    socket.addEventListener('open', () => {
      clearTimeout(connectTimer);
      resolve({
        socket,
        onEvent: fn => eventListeners.add(fn),
        send(method, params = {}) {
          if (socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('CDP socket is not open'));
          }
          return new Promise((res, rej) => {
            const id = ++sequence;
            const timeoutMs =
              method === 'Runtime.evaluate' ? CDP_EVALUATE_TIMEOUT_MS : CDP_COMMAND_TIMEOUT_MS;
            const timer = setTimeout(() => {
              pendingRequests.delete(id);
              rej(new Error(`${method} timed out`));
            }, timeoutMs);
            pendingRequests.set(id, { resolve: res, reject: rej, timer });
            socket.send(JSON.stringify({ id, method, params }));
          });
        }
      });
    });
  });
}

export function publicClientSettings(fullSettings) {
  const { apiKey: _redacted, ...rest } = fullSettings;
  return rest;
}

export function isPowertoolsEnabled({ home = homedir() } = {}) {
  try {
    const configPath = join(home, '.gemini', 'config', 'config.json');
    if (!existsSync(configPath)) return false;
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    return parsed?.plugins?.['agy-powertools']?.enabled === true;
  } catch {
    return false;
  }
}

export function buildInjectedScript({
  origin,
  version = PLUGIN_VERSION,
  settings,
  nativeHooks,
  coexistWithPowertools = isPowertoolsEnabled(),
  powertoolsYieldMaxMs = POWERTOOLS_YIELD_MAX_MS
}) {
  const clientBody = readFileSync(CLIENT_SCRIPT_PATH, 'utf8');
  const configPayload = {
    version,
    settings: publicClientSettings(settings),
    nativeHooks: nativeHooks || { segmentName: null, providerName: null },
    coexistWithPowertools: Boolean(coexistWithPowertools),
    powertoolsYieldMaxMs
  };
  return `if (location.origin === ${JSON.stringify(origin)} && window === window.top) {\nglobalThis.__agyThinkingTranslatorConfig = ${JSON.stringify(configPayload)};\n${clientBody}\n}`;
}

export function startCdpHostBridge({
  settingsStore,
  translator,
  cache,
  dataDirectory = resolvePluginDataDirectory(),
  portFilePath,
  version = PLUGIN_VERSION,
  onStatus = () => {}
}) {
  const activePortFile = resolveDevToolsActivePortFile({ portFile: portFilePath });
  const hookCacheFile = join(dataDirectory, 'native-hooks-cache.json');
  const attachedClients = new Map();
  const hookMemoryCache = new Map();
  let stopped = false;
  let pollInProgress = false;
  let lastStatusMessage = '';

  const reportStatus = msg => {
    if (msg !== lastStatusMessage) {
      lastStatusMessage = msg;
      onStatus(`[thinking-translator] ${msg}`);
    }
  };

  async function resolveHookNames(origin, appVersion, cdpClient) {
    const cacheKey = createHash('sha256')
      .update(`${process.platform}:${appVersion}`, 'utf8')
      .digest('hex')
      .slice(0, 24);
    if (hookMemoryCache.has(cacheKey)) {
      return hookMemoryCache.get(cacheKey);
    }
    if (existsSync(hookCacheFile)) {
      try {
        const disk = JSON.parse(readFileSync(hookCacheFile, 'utf8'));
        if (disk?.cacheKey === cacheKey && disk.hooks?.segmentName) {
          hookMemoryCache.set(cacheKey, disk.hooks);
          return disk.hooks;
        }
      } catch {}
    }

    let sourceText = '';
    try {
      sourceText = await fetchLocalMainBundle(origin);
    } catch {
      try {
        const evalRes = await cdpClient.send('Runtime.evaluate', {
          expression: `fetch('/main.js').then(r => r.ok ? r.text() : '')`,
          awaitPromise: true,
          returnByValue: true
        });
        sourceText = evalRes?.result?.value || '';
      } catch {}
    }

    const hooks = parseNativeHookNamesFromSource(sourceText);
    if (hooks.segmentName) {
      hookMemoryCache.set(cacheKey, hooks);
      try {
        writeJsonAtomically(hookCacheFile, { cacheKey, appVersion, hooks });
      } catch {}
    }
    return hooks;
  }

  // Throttle streaming delta pushes per key so high-frequency SSE chunks stay smooth
  const pendingDeltaEvents = new Map();
  let deltaFlushTimer = null;

  function broadcastEventToRenderers(eventPayload) {
    if (stopped || attachedClients.size === 0) return;
    const expression = `globalThis.${CLIENT_PUSH_GLOBAL}?.(${JSON.stringify(eventPayload)})`;
    for (const entry of attachedClients.values()) {
      for (const contextId of entry.contexts) {
        void entry.client
          .send('Runtime.evaluate', { expression, contextId })
          .catch(() => {});
      }
    }
  }

  function flushStreamingDeltas() {
    deltaFlushTimer = null;
    if (pendingDeltaEvents.size === 0) return;
    const events = [...pendingDeltaEvents.values()];
    pendingDeltaEvents.clear();
    for (const ev of events) {
      broadcastEventToRenderers(ev);
    }
  }

  function pushTranslationUpdate(update) {
    const event = { type: 'translation', ...update };
    if (update.status === 'streaming') {
      pendingDeltaEvents.set(update.key, event);
      if (!deltaFlushTimer) {
        deltaFlushTimer = setTimeout(flushStreamingDeltas, 65);
        deltaFlushTimer.unref?.();
      }
      return;
    }
    pendingDeltaEvents.delete(update.key);
    broadcastEventToRenderers(event);
  }

  async function refreshPersistentScriptForClient(entry) {
    const source = buildInjectedScript({
      origin: entry.origin,
      version,
      settings: settingsStore.get(),
      nativeHooks: entry.nativeHooks
    });
    if (entry.scriptId) {
      await entry.client
        .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.scriptId })
        .catch(() => {});
    }
    const installed = await entry.client.send('Page.addScriptToEvaluateOnNewDocument', { source });
    entry.scriptId = installed.identifier;
    return source;
  }

  async function attachTarget(target) {
    const client = await connectCdpSocket(target.webSocketDebuggerUrl);
    const origin = new URL(target.url).origin;
    const frameTree = await client.send('Page.getFrameTree');
    const mainFrameId = frameTree.frameTree.frame.id;
    const contexts = new Set();

    const entry = {
      targetId: target.id,
      client,
      origin,
      endpoint: target.webSocketDebuggerUrl,
      contexts,
      scriptId: null,
      nativeHooks: { segmentName: null, providerName: null }
    };
    attachedClients.set(target.id, entry);

    client.socket.addEventListener('close', () => {
      if (attachedClients.get(target.id) === entry) {
        attachedClients.delete(target.id);
      }
    });

    client.onEvent(async event => {
      if (event.method === 'Runtime.executionContextCreated') {
        const ctx = event.params.context;
        if (ctx.origin === origin && ctx.auxData?.isDefault && ctx.auxData.frameId === mainFrameId) {
          contexts.add(ctx.id);
        }
        return;
      }
      if (event.method === 'Runtime.executionContextDestroyed') {
        contexts.delete(event.params.executionContextId);
        return;
      }
      if (event.method === 'Runtime.executionContextsCleared') {
        contexts.clear();
        return;
      }
      if (event.method !== 'Runtime.bindingCalled' || event.params.name !== HOST_BINDING_NAME) {
        return;
      }
      if (!contexts.has(event.params.executionContextId)) {
        return;
      }
      const rawPayload = event.params.payload || '';
      if (Buffer.byteLength(rawPayload, 'utf8') > CDP_MAX_BINDING_PAYLOAD_BYTES) {
        return;
      }

      let rpcRequest;
      try {
        rpcRequest = JSON.parse(rawPayload);
      } catch {
        return;
      }
      if (!Number.isInteger(rpcRequest?.id)) return;

      let reply;
      try {
        if (rpcRequest.method === 'settings.get') {
          reply = publicClientSettings(settingsStore.get());
        } else if (rpcRequest.method === 'translate.batch') {
          const paragraphs = Array.isArray(rpcRequest.paragraphs)
            ? rpcRequest.paragraphs.slice(0, 24)
            : [];
          const states = translator.translateBatch(paragraphs, {
            forceRetry: rpcRequest.forceRetry === true
          });
          reply = { states };
        } else if (rpcRequest.method === 'translate.snapshot') {
          const keys = Array.isArray(rpcRequest.keys) ? rpcRequest.keys.slice(0, 64) : [];
          reply = { states: translator.snapshotForKeys(keys) };
        } else {
          throw new Error(`Unsupported method: ${rpcRequest.method}`);
        }
      } catch (err) {
        reply = { error: err.message };
      }

      await client
        .send('Runtime.evaluate', {
          expression: `globalThis.${CLIENT_RECEIVE_GLOBAL}?.(${JSON.stringify(rpcRequest.id)}, ${JSON.stringify(reply)})`,
          contextId: event.params.executionContextId
        })
        .catch(() => {});
    });

    await client.send('Runtime.enable');
    await client.send('Runtime.addBinding', { name: HOST_BINDING_NAME });

    const uaEval = await client.send('Runtime.evaluate', {
      expression: 'navigator.userAgent',
      returnByValue: true
    });
    const appVersion = uaEval?.result?.value?.match?.(/Antigravity\/([0-9.]+)/)?.[1] || 'unknown';
    entry.nativeHooks = await resolveHookNames(origin, appVersion, client);

    await client.send('Page.enable');
    const source = await refreshPersistentScriptForClient(entry);
    const evalResult = await client.send('Runtime.evaluate', { expression: source });
    if (evalResult.exceptionDetails) {
      throw new Error(evalResult.exceptionDetails.text || 'Client script evaluation error');
    }
    reportStatus('已接入 Antigravity 聊天界面');
  }

  async function pollTargets() {
    if (stopped || pollInProgress) return;
    pollInProgress = true;
    try {
      if (!existsSync(activePortFile)) {
        throw new Error('未检测到 DevToolsActivePort');
      }
      const portNumber = Number(readFileSync(activePortFile, 'utf8').split(/\r?\n/)[0]);
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
        throw new Error('调试端口号无效');
      }

      const allTargets = await fetchLocalCdpTargets(portNumber);
      const hubTargets = allTargets.filter(isAntigravityHubTarget);

      for (const target of hubTargets) {
        let existing = attachedClients.get(target.id);
        try {
          if (
            existing &&
            (existing.origin !== new URL(target.url).origin ||
              existing.endpoint !== target.webSocketDebuggerUrl)
          ) {
            existing.client.socket.close();
            attachedClients.delete(target.id);
            existing = null;
          }
          if (!existing) {
            await attachTarget(target);
          } else {
            const checkRes = await existing.client.send('Runtime.evaluate', {
              expression: `location.origin === ${JSON.stringify(existing.origin)} && (!globalThis.${CLIENT_INSTANCE_GLOBAL} || globalThis.${CLIENT_INSTANCE_GLOBAL}.healthy !== true) && document.readyState !== 'loading'`,
              returnByValue: true
            });
            if (checkRes?.result?.value === true) {
              const source = await refreshPersistentScriptForClient(existing);
              await existing.client.send('Runtime.evaluate', { expression: source });
              reportStatus('已恢复聊天界面思维链翻译组件');
            }
          }
        } catch (err) {
          attachedClients.get(target.id)?.client?.socket?.close();
          attachedClients.delete(target.id);
          reportStatus(`窗口连接重试: ${err.message}`);
        }
      }

      const activeIds = new Set(hubTargets.map(t => t.id));
      for (const [id, entry] of attachedClients.entries()) {
        if (!activeIds.has(id)) {
          entry.client.socket.close();
          attachedClients.delete(id);
        }
      }
      if (hubTargets.length === 0) {
        reportStatus('等待 Antigravity 聊天窗口');
      }
    } catch (err) {
      reportStatus(err.message || '等待本机调试端口');
    } finally {
      pollInProgress = false;
    }
  }

  const pollTimer = setInterval(pollTargets, CDP_POLL_INTERVAL_MS);
  pollTimer.unref?.();
  const initialReady = pollTargets();

  return {
    ready: initialReady,
    pollNow: pollTargets,
    pushTranslationUpdate,
    async notifySettingsChanged(nextSettings) {
      for (const entry of attachedClients.values()) {
        await refreshPersistentScriptForClient(entry).catch(() => {});
      }
      broadcastEventToRenderers({
        type: 'settings',
        settings: publicClientSettings(nextSettings)
      });
    },
    notifyCacheCleared() {
      cache.clear();
      broadcastEventToRenderers({ type: 'cache-cleared' });
    },
    async getHealth() {
      await initialReady;
      let healthyWindows = 0;
      let totalRenderedBlocks = 0;
      for (const entry of attachedClients.values()) {
        try {
          const res = await entry.client.send('Runtime.evaluate', {
            expression: `({ healthy: globalThis.${CLIENT_INSTANCE_GLOBAL}?.healthy === true, version: globalThis.${CLIENT_INSTANCE_GLOBAL}?.version, stats: globalThis.${CLIENT_INSTANCE_GLOBAL}?.stats })`,
            returnByValue: true
          });
          const val = res?.result?.value;
          if (val?.healthy && val?.version === version) {
            healthyWindows++;
            totalRenderedBlocks += Number(val.stats?.renderedBlocks || 0);
          }
        } catch {}
      }
      return {
        healthy: healthyWindows > 0,
        attachedWindows: healthyWindows,
        renderedBlocks: totalRenderedBlocks,
        lastStatus: lastStatusMessage
      };
    },
    async stop() {
      stopped = true;
      clearInterval(pollTimer);
      if (deltaFlushTimer) clearTimeout(deltaFlushTimer);
      for (const entry of attachedClients.values()) {
        try {
          if (entry.scriptId) {
            await entry.client.send('Page.removeScriptToEvaluateOnNewDocument', {
              identifier: entry.scriptId
            });
          }
          await entry.client.send('Runtime.evaluate', {
            expression: `globalThis.${CLIENT_INSTANCE_GLOBAL}?.dispose?.()`
          });
        } catch {}
        try {
          entry.client.socket.close();
        } catch {}
      }
      attachedClients.clear();
      cache.flush();
    }
  };
}
