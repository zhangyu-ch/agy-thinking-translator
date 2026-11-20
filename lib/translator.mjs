import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  MAX_CONCURRENT_TRANSLATIONS,
  TRANSLATION_REQUEST_TIMEOUT_MS,
  TRANSLATION_RETRY_COUNT,
  TRANSLATION_RETRY_DELAY_MS,
  TRANSLATION_SYSTEM_PROMPT
} from './constants.mjs';
import { normalizeBaseUrl, normalizeTranslatorModelId } from './settings.mjs';
import {
  clampSourceParagraph,
  computeParagraphKey,
  shouldTranslateThinking
} from './text-splitter.mjs';

const THINK_TAG_BLOCK_REGEX = /<think>[\s\S]*?<\/think>/gi;
const UNCLOSED_THINK_TAG_REGEX = /<think>[\s\S]*$/i;

function sanitizeTranslatedOutput(rawText, { isPartial = false } = {}) {
  if (typeof rawText !== 'string') return '';
  let cleaned = rawText.replace(THINK_TAG_BLOCK_REGEX, '');
  if (isPartial) {
    cleaned = cleaned.replace(UNCLOSED_THINK_TAG_REGEX, '');
  }
  return cleaned.trim();
}

function mapReasoningEffort(thinkingLevel) {
  if (!thinkingLevel || thinkingLevel === 'off' || thinkingLevel === 'minimal') {
    return undefined;
  }
  if (thinkingLevel === 'low' || thinkingLevel === 'medium' || thinkingLevel === 'high') {
    return thinkingLevel;
  }
  if (thinkingLevel === 'xhigh' || thinkingLevel === 'max') {
    return 'high';
  }
  return 'low';
}

function delayMs(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function performDirectJsonStreamRequest({
  endpointUrl,
  apiKey,
  requestBody,
  timeoutMs = TRANSLATION_REQUEST_TIMEOUT_MS,
  onDelta
}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(endpointUrl);
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const payloadBuffer = Buffer.from(JSON.stringify(requestBody), 'utf8');

    let settled = false;
    const finishError = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    };
    const finishSuccess = text => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(text);
    };

    const req = transport.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'text/event-stream, application/json',
          Authorization: `Bearer ${apiKey || 'magpie'}`,
          'Content-Length': payloadBuffer.length
        }
      },
      res => {
        const statusCode = res.statusCode || 0;
        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        res.setEncoding('utf8');

        if (statusCode < 200 || statusCode >= 300) {
          let errorBody = '';
          res.on('data', chunk => {
            if (errorBody.length < 4096) errorBody += chunk;
          });
          res.on('end', () => {
            const error = new Error(
              `HTTP ${statusCode}: ${errorBody.trim().slice(0, 280) || res.statusMessage || 'Request failed'}`
            );
            error.statusCode = statusCode;
            finishError(error);
          });
          res.on('error', finishError);
          return;
        }

        if (!contentType.includes('text/event-stream')) {
          let rawJson = '';
          res.on('data', chunk => {
            rawJson += chunk;
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(rawJson);
              const content = parsed?.choices?.[0]?.message?.content || '';
              const finalClean = sanitizeTranslatedOutput(content, { isPartial: false });
              if (finalClean) onDelta?.(finalClean);
              finishSuccess(finalClean);
            } catch (parseErr) {
              finishError(new Error(`Invalid JSON response: ${parseErr.message}`));
            }
          });
          res.on('error', finishError);
          return;
        }

        let accumulatedContent = '';
        let sseLineBuffer = '';

        const processLine = rawLine => {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) return;
          const dataPayload = line.slice(5).trim();
          if (!dataPayload || dataPayload === '[DONE]') return;
          try {
            const parsedChunk = JSON.parse(dataPayload);
            const deltaContent =
              parsedChunk?.choices?.[0]?.delta?.content ??
              parsedChunk?.choices?.[0]?.message?.content ??
              '';
            if (typeof deltaContent === 'string' && deltaContent.length > 0) {
              accumulatedContent += deltaContent;
              const cleanedPartial = sanitizeTranslatedOutput(accumulatedContent, { isPartial: true });
              if (cleanedPartial) {
                onDelta?.(cleanedPartial);
              }
            }
          } catch {
            // Ignore non-JSON keepalive comments or partial metadata frames.
          }
        };

        res.on('data', chunk => {
          sseLineBuffer += chunk;
          let newlineIndex;
          while ((newlineIndex = sseLineBuffer.indexOf('\n')) !== -1) {
            const line = sseLineBuffer.slice(0, newlineIndex);
            sseLineBuffer = sseLineBuffer.slice(newlineIndex + 1);
            processLine(line);
          }
        });

        res.on('end', () => {
          if (sseLineBuffer.trim()) {
            processLine(sseLineBuffer);
          }
          finishSuccess(sanitizeTranslatedOutput(accumulatedContent, { isPartial: false }));
        });

        res.on('error', finishError);
      }
    );

    const timeoutHandle = setTimeout(() => {
      req.destroy(new Error(`Translation request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    req.on('error', finishError);
    req.write(payloadBuffer);
    req.end();
  });
}

export async function checkMagpieGatewayHealth({ baseUrl, apiKey, timeoutMs = 3_500 } = {}) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const modelsUrl = new URL(`${normalizedBase}/models`);
  const transport = modelsUrl.protocol === 'https:' ? https : http;

  return new Promise(resolve => {
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    const req = transport.request(
      {
        protocol: modelsUrl.protocol,
        hostname: modelsUrl.hostname,
        port: modelsUrl.port || (modelsUrl.protocol === 'https:' ? 443 : 80),
        path: `${modelsUrl.pathname}${modelsUrl.search}`,
        method: 'GET',
        agent: false,
        headers: {
          Authorization: `Bearer ${apiKey || 'magpie'}`,
          Accept: 'application/json'
        }
      },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          if (body.length < 16_384) body += chunk;
        });
        res.on('end', () => {
          const ok = (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300;
          finish({
            online: ok,
            statusCode: res.statusCode || 0,
            baseUrl: normalizedBase,
            error: ok ? null : `HTTP ${res.statusCode}`
          });
        });
        res.on('error', err => finish({ online: false, baseUrl: normalizedBase, error: err.message }));
      }
    );

    const timer = setTimeout(() => {
      req.destroy();
      finish({ online: false, baseUrl: normalizedBase, error: '连接超时' });
    }, timeoutMs);

    req.on('error', err => finish({ online: false, baseUrl: normalizedBase, error: err.message }));
    req.end();
  });
}

export function locateLocalMagpieExecutable({ home = homedir(), env = process.env } = {}) {
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const candidates = [
    join(localAppData, 'Programs', 'magpie', 'magpie.com'),
    join(localAppData, 'Programs', 'magpie', 'magpie.exe'),
    '/usr/local/bin/magpie',
    join(home, '.local', 'bin', 'magpie')
  ];
  for (const candidatePath of candidates) {
    if (existsSync(candidatePath)) return candidatePath;
  }
  return null;
}

export async function startLocalMagpieTray({ home = homedir(), env = process.env } = {}) {
  const executablePath = locateLocalMagpieExecutable({ home, env });
  if (!executablePath) {
    return { started: false, error: '未找到本机 Magpie 可执行文件' };
  }
  try {
    const child = spawn(executablePath, ['tray'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    return { started: true, executablePath };
  } catch (error) {
    return { started: false, error: error.message };
  }
}

export function createTranslatorService({
  settingsStore,
  cache,
  requestImpl = performDirectJsonStreamRequest,
  maxConcurrency = MAX_CONCURRENT_TRANSLATIONS,
  requestTimeoutMs = TRANSLATION_REQUEST_TIMEOUT_MS,
  retryCount = TRANSLATION_RETRY_COUNT,
  retryDelayMs = TRANSLATION_RETRY_DELAY_MS,
  onUpdate
}) {
  assert.ok(settingsStore, 'settingsStore is required');
  assert.ok(cache, 'cache is required');

  const inFlightPromises = new Map();
  const inFlightPartials = new Map();
  const lastErrors = new Map();
  const waitQueue = [];
  let activeCount = 0;
  let totalRequests = 0;
  let totalSuccesses = 0;
  let totalFailures = 0;

  function acquireSlot() {
    if (activeCount < maxConcurrency) {
      activeCount++;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      waitQueue.push(resolve);
    });
  }

  function releaseSlot() {
    const nextResolver = waitQueue.shift();
    if (nextResolver) {
      nextResolver();
    } else {
      activeCount = Math.max(0, activeCount - 1);
    }
  }

  function emitUpdate(payload) {
    try {
      onUpdate?.(payload);
    } catch {
      // Listener errors must not interrupt translation flow.
    }
  }

  async function requestSingleParagraph(sourceText, settings, paragraphKey) {
    const endpointUrl = `${normalizeBaseUrl(settings.baseUrl)}/chat/completions`;
    const modelId = normalizeTranslatorModelId(settings.translatorModel);
    const reasoningEffort = mapReasoningEffort(settings.translatorThinking);

    const buildBody = includeReasoningEffort => {
      const body = {
        model: modelId,
        stream: true,
        messages: [
          { role: 'system', content: TRANSLATION_SYSTEM_PROMPT },
          { role: 'user', content: sourceText }
        ]
      };
      if (includeReasoningEffort && reasoningEffort) {
        body.reasoning_effort = reasoningEffort;
      }
      return body;
    };

    let lastError = null;
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      if (attempt > 0) {
        await delayMs(retryDelayMs);
      }
      try {
        const includeReasoning = Boolean(reasoningEffort) && !(lastError?.statusCode === 400);
        const translated = await requestImpl({
          endpointUrl,
          apiKey: settings.apiKey,
          requestBody: buildBody(includeReasoning),
          timeoutMs: requestTimeoutMs,
          onDelta: partialText => {
            inFlightPartials.set(paragraphKey, partialText);
            emitUpdate({
              key: paragraphKey,
              status: 'streaming',
              translation: partialText
            });
          }
        });
        if (translated) return translated;
        lastError = new Error('翻译模型返回空结果');
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('翻译请求失败');
  }

  function translateParagraph(rawParagraphText, { forceRetry = false } = {}) {
    if (typeof rawParagraphText !== 'string' || !shouldTranslateThinking(rawParagraphText)) {
      return Promise.resolve({ skipped: true });
    }

    const clampedSource = clampSourceParagraph(rawParagraphText);
    const paragraphKey = computeParagraphKey(clampedSource);

    if (!forceRetry) {
      const cachedTranslation = cache.getByKey(paragraphKey);
      if (cachedTranslation) {
        return Promise.resolve({
          key: paragraphKey,
          status: 'done',
          translation: cachedTranslation,
          cached: true
        });
      }
    }

    if (inFlightPromises.has(paragraphKey)) {
      return inFlightPromises.get(paragraphKey);
    }

    lastErrors.delete(paragraphKey);
    inFlightPartials.set(paragraphKey, '');
    emitUpdate({
      key: paragraphKey,
      status: 'pending',
      translation: ''
    });

    const jobPromise = (async () => {
      await acquireSlot();
      totalRequests++;
      try {
        const currentSettings = settingsStore.get();
        if (!currentSettings.enabled) {
          return { key: paragraphKey, status: 'disabled' };
        }

        const finalTranslation = await requestSingleParagraph(
          clampedSource,
          currentSettings,
          paragraphKey
        );

        cache.setByKey(paragraphKey, finalTranslation);
        totalSuccesses++;
        lastErrors.delete(paragraphKey);
        emitUpdate({
          key: paragraphKey,
          status: 'done',
          translation: finalTranslation
        });
        return {
          key: paragraphKey,
          status: 'done',
          translation: finalTranslation
        };
      } catch (error) {
        totalFailures++;
        const errorMessage = error?.message || '翻译失败';
        lastErrors.set(paragraphKey, errorMessage);
        emitUpdate({
          key: paragraphKey,
          status: 'error',
          error: errorMessage
        });
        return {
          key: paragraphKey,
          status: 'error',
          error: errorMessage
        };
      } finally {
        inFlightPartials.delete(paragraphKey);
        inFlightPromises.delete(paragraphKey);
        releaseSlot();
      }
    })();

    inFlightPromises.set(paragraphKey, jobPromise);
    return jobPromise;
  }

  function translateBatch(paragraphs = [], { forceRetry = false } = {}) {
    const immediateStates = {};
    for (const item of paragraphs) {
      const text = typeof item === 'string' ? item : item?.text;
      if (typeof text !== 'string' || !shouldTranslateThinking(text)) continue;
      const clamped = clampSourceParagraph(text);
      const key = computeParagraphKey(clamped);
      if (!forceRetry) {
        const cached = cache.getByKey(key);
        if (cached) {
          immediateStates[key] = { status: 'done', translation: cached };
          continue;
        }
      }
      if (inFlightPartials.has(key)) {
        const partial = inFlightPartials.get(key);
        immediateStates[key] = {
          status: partial ? 'streaming' : 'pending',
          translation: partial || ''
        };
        continue;
      }
      immediateStates[key] = { status: 'pending', translation: '' };
      void translateParagraph(clamped, { forceRetry });
    }
    return immediateStates;
  }

  function snapshotForKeys(keys = []) {
    const states = {};
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      const cached = cache.getByKey(key);
      if (cached) {
        states[key] = { status: 'done', translation: cached };
      } else if (inFlightPartials.has(key)) {
        const partial = inFlightPartials.get(key);
        states[key] = {
          status: partial ? 'streaming' : 'pending',
          translation: partial || ''
        };
      } else if (lastErrors.has(key)) {
        states[key] = { status: 'error', error: lastErrors.get(key) };
      }
    }
    return states;
  }

  function metrics() {
    return {
      activeCount,
      queuedCount: waitQueue.length,
      totalRequests,
      totalSuccesses,
      totalFailures,
      ...cache.stats()
    };
  }

  return {
    translateParagraph,
    translateBatch,
    snapshotForKeys,
    metrics
  };
}
