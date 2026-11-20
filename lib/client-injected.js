(() => {
  const bootstrapConfig = globalThis.__agyThinkingTranslatorConfig || {};
  const pluginVersion = bootstrapConfig.version || '1.0.0';

  if (
    globalThis.__agyThinkingTranslator?.version === pluginVersion &&
    globalThis.__agyThinkingTranslator?.healthy === true
  ) {
    return;
  }

  globalThis.__agyThinkingTranslator?.dispose?.();

  const DEFAULT_SETTINGS = {
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

  let settings = { ...DEFAULT_SETTINGS, ...(bootstrapConfig.settings || {}) };
  let disposed = false;
  let rpcSequence = 0;
  const pendingRpcCalls = new Map();

  // paragraphKey -> { status: 'pending' | 'streaming' | 'done' | 'error', translation?: string, error?: string }
  const paragraphStateMap = new Map();
  const requestedKeys = new Set();
  const keyToSourceMap = new Map();

  // WeakSets for non-intrusive DOM tracking
  const userToggledTriggers = new WeakSet();
  const autoManagedActiveTriggers = new WeakSet();
  const autoExpandedContainers = new WeakSet();
  const collapsedChineseBlocks = new WeakSet();

  // Pure JS synchronous SHA-256 (first 32 hex chars) matching Node's computeParagraphKey
  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const utf8Encoder = new TextEncoder();

  function sha256Key32(inputText) {
    const bytes = utf8Encoder.encode(inputText);
    const bitLenHi = Math.floor((bytes.length * 8) / 0x100000000);
    const bitLenLo = (bytes.length * 8) >>> 0;
    const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
    const buffer = new Uint8Array(paddedLength);
    buffer.set(bytes);
    buffer[bytes.length] = 0x80;
    const view = new DataView(buffer.buffer);
    view.setUint32(paddedLength - 8, bitLenHi, false);
    view.setUint32(paddedLength - 4, bitLenLo, false);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);

    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let i = 0; i < 16; i++) {
        w[i] = view.getUint32(offset + i * 4, false);
      }
      for (let i = 16; i < 64; i++) {
        const s0 = (((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3)) >>> 0;
        const s1 = (((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }

      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
        const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
        const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const temp2 = (S0 + maj) >>> 0;

        h = g; g = f; f = e;
        e = (d + temp1) >>> 0;
        d = c; c = b; b = a;
        a = (temp1 + temp2) >>> 0;
      }

      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }

    const hex8 = n => n.toString(16).padStart(8, '0');
    return `${hex8(h0)}${hex8(h1)}${hex8(h2)}${hex8(h3)}`;
  }

  const MAX_SOURCE_PARAGRAPH_LENGTH = 16000;
  const CJK_SKIP_RATIO_THRESHOLD = 0.22;

  function clampParagraph(rawText) {
    const normalized = String(rawText || '').replace(/\r\n/g, '\n').trim();
    return normalized.length <= MAX_SOURCE_PARAGRAPH_LENGTH
      ? normalized
      : normalized.slice(0, MAX_SOURCE_PARAGRAPH_LENGTH);
  }

  function splitThinkingParagraphs(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) return [];
    const lines = rawText.replace(/\r\n/g, '\n').split('\n');
    const paragraphs = [];
    let current = [];
    let fenceMarker = null;

    const flush = () => {
      const joined = current.join('\n').trim();
      if (joined) paragraphs.push(joined);
      current = [];
    };

    for (const line of lines) {
      const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        if (!fenceMarker) {
          fenceMarker = marker;
        } else if (
          marker[0] === fenceMarker[0] &&
          marker.length >= fenceMarker.length &&
          /^\s{0,3}(?:`+|~+)\s*$/.test(line)
        ) {
          fenceMarker = null;
        }
        current.push(line);
        continue;
      }
      if (!fenceMarker && line.trim() === '') {
        flush();
        continue;
      }
      current.push(line);
    }
    flush();

    const merged = [];
    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      if (/^#{1,6}\s+\S[^\n]*$/.test(p) && i + 1 < paragraphs.length) {
        paragraphs[i + 1] = `${p}\n\n${paragraphs[i + 1]}`;
      } else {
        merged.push(p);
      }
    }
    return merged;
  }

  function shouldTranslateThinking(paragraphText) {
    if (typeof paragraphText !== 'string') return false;
    const withoutFenced = paragraphText.replace(/^\s{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s{0,3}\1\s*$/gm, '');
    const withoutInline = withoutFenced.replace(/`[^`\n]+`/g, '').trim();
    if (!withoutInline || !/[a-zA-Z]/.test(withoutInline)) return false;
    const nonWs = withoutInline.match(/\S/g);
    const cjk = withoutInline.match(/[\u4e00-\u9fff]/g);
    if (nonWs && cjk && cjk.length / nonWs.length >= CJK_SKIP_RATIO_THRESHOLD) {
      return false;
    }
    return true;
  }

  function callHost(method, payload = {}) {
    if (typeof globalThis.__agyThinkingTranslatorHost !== 'function') {
      return Promise.reject(new Error('Host binding unavailable'));
    }
    return new Promise((resolve, reject) => {
      const id = ++rpcSequence;
      const timer = setTimeout(() => {
        pendingRpcCalls.delete(id);
        reject(new Error(`Host RPC timeout: ${method}`));
      }, 15000);
      pendingRpcCalls.set(id, { resolve, reject, timer });
      globalThis.__agyThinkingTranslatorHost(JSON.stringify({ id, method, ...payload }));
    });
  }

  globalThis.__agyThinkingTranslatorReceive = (id, reply) => {
    const entry = pendingRpcCalls.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingRpcCalls.delete(id);
    if (reply?.error) entry.reject(new Error(reply.error));
    else entry.resolve(reply);
  };

  let renderScheduled = false;
  function scheduleDomSync() {
    if (disposed || renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if (!disposed) syncAllThinkingBlocks();
    });
  }

  globalThis.__agyThinkingTranslatorPush = event => {
    if (disposed || !event || typeof event !== 'object') return;
    if (event.type === 'translation' && typeof event.key === 'string') {
      paragraphStateMap.set(event.key, {
        status: event.status,
        translation: event.translation || '',
        error: event.error || ''
      });
      if (event.status === 'error') {
        requestedKeys.delete(event.key);
      }
      scheduleDomSync();
    } else if (event.type === 'settings' && event.settings) {
      settings = { ...DEFAULT_SETTINGS, ...event.settings };
      ensureNativeHooks();
      scheduleDomSync();
    } else if (event.type === 'cache-cleared') {
      paragraphStateMap.clear();
      requestedKeys.clear();
      scheduleDomSync();
    }
  };

  // Batch queue to avoid flooding binding calls on multi-paragraph bursts
  const pendingParagraphBatch = new Map();
  let batchFlushTimer = null;

  function queueParagraphForTranslation(rawParagraph, { forceRetry = false } = {}) {
    const clamped = clampParagraph(rawParagraph);
    if (!clamped || !shouldTranslateThinking(clamped)) return null;
    const key = sha256Key32(clamped);
    keyToSourceMap.set(key, clamped);

    const existing = paragraphStateMap.get(key);
    if (!forceRetry && (existing?.status === 'done' || requestedKeys.has(key))) {
      return key;
    }

    requestedKeys.add(key);
    if (!existing || forceRetry) {
      paragraphStateMap.set(key, { status: 'pending', translation: '' });
    }
    pendingParagraphBatch.set(key, { text: clamped, forceRetry });

    if (!batchFlushTimer) {
      batchFlushTimer = setTimeout(flushParagraphBatch, 25);
    }
    return key;
  }

  function flushParagraphBatch() {
    batchFlushTimer = null;
    if (disposed || pendingParagraphBatch.size === 0) return;
    const entries = [...pendingParagraphBatch.values()];
    pendingParagraphBatch.clear();

    const chunkSize = 6;
    for (let i = 0; i < entries.length; i += chunkSize) {
      const slice = entries.slice(i, i + chunkSize);
      const forceRetry = slice.some(item => item.forceRetry);
      void callHost('translate.batch', {
        paragraphs: slice.map(item => item.text),
        forceRetry
      })
        .then(reply => {
          if (reply?.states && typeof reply.states === 'object') {
            for (const [k, state] of Object.entries(reply.states)) {
              const current = paragraphStateMap.get(k);
              if (!current || state.status === 'done' || (state.translation && !current.translation)) {
                paragraphStateMap.set(k, state);
              }
            }
            scheduleDomSync();
          }
        })
        .catch(err => {
          for (const item of slice) {
            const k = sha256Key32(item.text);
            requestedKeys.delete(k);
            if (paragraphStateMap.get(k)?.status !== 'done') {
              paragraphStateMap.set(k, { status: 'error', error: err.message });
            }
          }
          scheduleDomSync();
        });
    }
  }

  function observeThinkingContent(thinkingText, isActivelyThinking) {
    if (!settings.enabled || typeof thinkingText !== 'string' || !thinkingText.trim()) return;
    const paragraphs = splitThinkingParagraphs(thinkingText);
    if (paragraphs.length === 0) return;
    const targetParagraphs = isActivelyThinking ? paragraphs.slice(0, -1) : paragraphs;
    for (const paragraph of targetParagraphs) {
      queueParagraphForTranslation(paragraph);
    }
  }

  // React Fiber helpers
  function getReactFiber(domElement) {
    if (!domElement || typeof domElement !== 'object') return null;
    for (const propKey of Object.keys(domElement)) {
      if (propKey.startsWith('__reactFiber$')) {
        return domElement[propKey];
      }
    }
    return null;
  }

  function hasStepThinkingText(stepObj) {
    if (!stepObj || typeof stepObj !== 'object') return false;
    if (stepObj.step?.case === 'plannerResponse') {
      const val = stepObj.step.value;
      return Boolean((val?.rawThinking || val?.thinking || '').trim());
    }
    return false;
  }

  function inspectStepThinking(stepObj, isActiveSegment) {
    if (!hasStepThinkingText(stepObj)) return false;
    const val = stepObj.step.value;
    const text = val.rawThinking || val.thinking || '';
    const status = stepObj.status;
    const hasNonThinking = Boolean(val.response?.trim() || (Array.isArray(val.toolCalls) && val.toolCalls.length > 0));
    const isActivelyThinking = Boolean(
      isActiveSegment &&
      (status === 2 || status === 4) &&
      !val.thinkingDuration &&
      !hasNonThinking
    );
    observeThinkingContent(text, isActivelyThinking);
    return true;
  }

  // Native function hooks (coexisting cleanly with agy-powertools)
  const hookedGlobals = new Map();

  function resolveHookNames() {
    const configured = bootstrapConfig.nativeHooks || {};
    const segmentName =
      configured.segmentName ||
      globalThis.__agyNativeBindingNames?.segment ||
      null;
    const providerName = configured.providerName || null;
    return { segmentName, providerName };
  }

  function ensureNativeHooks() {
    if (disposed) return;
    const { segmentName, providerName } = resolveHookNames();

    if (segmentName && typeof globalThis[segmentName] === 'function' && !globalThis[segmentName].__agyTTWrapped) {
      const delegateFn = globalThis[segmentName];
      const wrappedSegment = function (inputProps, ...rest) {
        const useVerbose = settings.enabled && settings.forceVerboseSteps;
        const patchedProps =
          useVerbose && inputProps && typeof inputProps === 'object'
            ? { ...inputProps, verboseAgentChat: true }
            : inputProps;

        const result = delegateFn.call(this, patchedProps, ...rest);
        if (!settings.enabled || !result || typeof result !== 'object') {
          return result;
        }

        const segmentSteps = Array.isArray(inputProps?.segment?.steps) ? inputProps.segment.steps : [];
        const isActiveSegment = Boolean(
          inputProps?.isRunning && inputProps?.isLastTurn && inputProps?.segment?.isLatest
        );
        let segmentHasThinking = false;
        for (const step of segmentSteps) {
          if (inspectStepThinking(step, isActiveSegment)) {
            segmentHasThinking = true;
          }
        }

        if (!segmentHasThinking || !settings.keepContainersExpanded) {
          return result;
        }

        let nextBody = result.body;
        if (nextBody?.content && Array.isArray(nextBody.content.groups)) {
          const nextGroups = nextBody.content.groups.map(group => {
            if (
              group?.type === 'toolGroupCollapsible' &&
              Array.isArray(group.steps) &&
              group.steps.some(hasStepThinkingText)
            ) {
              return { ...group, isActive: true };
            }
            return group;
          });
          nextBody = { ...nextBody, content: { ...nextBody.content, groups: nextGroups } };
        }

        if (nextBody?.type === 'collapsible') {
          nextBody = {
            ...nextBody,
            defaultExpanded: true,
            isActive: nextBody.isActive ? true : undefined
          };
        }

        return { ...result, body: nextBody };
      };
      wrappedSegment.__agyTTWrapped = true;
      wrappedSegment.__agyTTDelegate = delegateFn;
      hookedGlobals.set(segmentName, { wrapper: wrappedSegment, delegate: delegateFn });
      globalThis[segmentName] = wrappedSegment;
    }

    if (providerName && typeof globalThis[providerName] === 'function' && !globalThis[providerName].__agyTTWrapped) {
      const delegateProvider = globalThis[providerName];
      const wrappedProvider = function (props, ...rest) {
        if (settings.enabled && settings.forceVerboseSteps && props && typeof props === 'object') {
          return delegateProvider.call(this, { ...props, verboseAgentChat: true }, ...rest);
        }
        return delegateProvider.call(this, props, ...rest);
      };
      wrappedProvider.__agyTTWrapped = true;
      wrappedProvider.__agyTTDelegate = delegateProvider;
      hookedGlobals.set(providerName, { wrapper: wrappedProvider, delegate: delegateProvider });
      globalThis[providerName] = wrappedProvider;
    }
  }

  function restoreNativeHooks() {
    for (const [name, record] of hookedGlobals.entries()) {
      if (globalThis[name] === record.wrapper) {
        globalThis[name] = record.delegate;
      }
    }
    hookedGlobals.clear();
  }

  // Extract thinking info from a mounted collapsible trigger button via React Fiber
  function extractThinkingInfoFromTrigger(triggerButton) {
    const fiberRoot = getReactFiber(triggerButton);
    if (!fiberRoot) return null;

    let currentFiber = fiberRoot;
    let p2IsActive = undefined;

    for (let depth = 0; currentFiber && depth < 18; depth++, currentFiber = currentFiber.return) {
      const props = currentFiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;

      if (p2IsActive === undefined && 'defaultExpanded' in props && 'onCollapseComplete' in props) {
        p2IsActive = Boolean(props.isActive);
      }

      // Main chat gxc component: { thinking, thinkingDuration, metadata, status, stepHasNonThinkingContent }
      if (typeof props.thinking === 'string' && props.thinking.trim()) {
        const isActivelyThinking =
          p2IsActive !== undefined
            ? p2IsActive
            : Boolean(
                (props.status === 2 || props.status === 4) &&
                !props.thinkingDuration &&
                !props.stepHasNonThinkingContent
              );
        return {
          thinking: props.thinking,
          isActivelyThinking,
          thinkingDuration: props.thinkingDuration || null,
          stepIndex: props.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? -1
        };
      }

      // Subagent / inline bubble thinking p2: children -> div -> markdownRenderer({ markdown })
      const nestedMarkdown =
        props.children?.props?.children?.props?.markdown ??
        props.markdown;
      if (typeof nestedMarkdown === 'string' && nestedMarkdown.trim() && ('trigger' in props || depth > 2)) {
        const label = String(triggerButton.getAttribute('aria-label') || triggerButton.textContent || '').trim();
        const isActivelyThinking =
          p2IsActive !== undefined ? p2IsActive : /^Thinking|^正在思考/.test(label);
        return {
          thinking: nestedMarkdown,
          isActivelyThinking,
          thinkingDuration: null,
          stepIndex: -1
        };
      }
    }

    return null;
  }

  // Check if an already-mounted outer container (worked-for / tool-group) holds thinking steps
  function containerHoldsThinking(triggerButton) {
    let cur = getReactFiber(triggerButton);
    for (let depth = 0; cur && depth < 20; depth++, cur = cur.return) {
      const props = cur.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      if (Array.isArray(props.steps) && props.steps.some(hasStepThinkingText)) {
        return true;
      }
      if (Array.isArray(props.segment?.steps) && props.segment.steps.some(hasStepThinkingText)) {
        return true;
      }
      const groups = props.node?.groups || props.children?.props?.node?.groups;
      if (Array.isArray(groups)) {
        for (const g of groups) {
          if (g?.type === 'thinkingIndicator' && g.thinking) return true;
          if (g?.type === 'step' && hasStepThinkingText(g.step)) return true;
          if (g?.type === 'toolGroupCollapsible' && Array.isArray(g.steps) && g.steps.some(hasStepThinkingText)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // Safe XSS-free Markdown to DOM builder for Chinese thinking paragraphs
  function appendInlineMarkdown(parentEl, lineText) {
    const tokenRegex = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
    let lastIndex = 0;
    let match;
    while ((match = tokenRegex.exec(lineText)) !== null) {
      if (match.index > lastIndex) {
        parentEl.appendChild(document.createTextNode(lineText.slice(lastIndex, match.index)));
      }
      const token = match[0];
      if (token.startsWith('`')) {
        const codeEl = document.createElement('code');
        codeEl.className = 'agy-tt-inline-code';
        codeEl.textContent = token.slice(1, -1);
        parentEl.appendChild(codeEl);
      } else if (token.startsWith('**')) {
        const strongEl = document.createElement('strong');
        strongEl.className = 'agy-tt-strong';
        strongEl.textContent = token.slice(2, -2);
        parentEl.appendChild(strongEl);
      }
      lastIndex = match.index + token.length;
    }
    if (lastIndex < lineText.length) {
      parentEl.appendChild(document.createTextNode(lineText.slice(lastIndex)));
    }
  }

  function populateParagraphContent(containerEl, markdownText) {
    containerEl.replaceChildren();
    const cleaned = String(markdownText || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/\r\n/g, '\n')
      .trim();
    if (!cleaned) return;

    const lines = cleaned.split('\n');
    let inCodeFence = false;
    let fenceMarker = '';
    let codeLines = [];
    let textLines = [];

    const flushTextLines = () => {
      if (textLines.length === 0) return;
      const spanBlock = document.createElement('div');
      spanBlock.className = 'agy-tt-text-lines';
      textLines.forEach((rawLine, idx) => {
        if (idx > 0) spanBlock.appendChild(document.createElement('br'));
        const headingMatch = rawLine.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
          const headingSpan = document.createElement('strong');
          headingSpan.className = 'agy-tt-heading';
          appendInlineMarkdown(headingSpan, headingMatch[2]);
          spanBlock.appendChild(headingSpan);
        } else {
          appendInlineMarkdown(spanBlock, rawLine);
        }
      });
      containerEl.appendChild(spanBlock);
      textLines = [];
    };

    const flushCodeFence = () => {
      const preEl = document.createElement('pre');
      preEl.className = 'agy-tt-code-block';
      const codeEl = document.createElement('code');
      codeEl.textContent = codeLines.join('\n');
      preEl.appendChild(codeEl);
      containerEl.appendChild(preEl);
      codeLines = [];
    };

    for (const line of lines) {
      const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        if (!inCodeFence) {
          flushTextLines();
          inCodeFence = true;
          fenceMarker = fenceMatch[1];
          continue;
        } else if (line.trim().startsWith(fenceMarker[0].repeat(fenceMarker.length))) {
          inCodeFence = false;
          fenceMarker = '';
          flushCodeFence();
          continue;
        }
      }
      if (inCodeFence) {
        codeLines.push(line);
      } else {
        textLines.push(line);
      }
    }
    if (inCodeFence && codeLines.length > 0) flushCodeFence();
    flushTextLines();
  }

  // Inject theme-adaptive stylesheet
  const styleElement = document.createElement('style');
  styleElement.dataset.agyThinkingTranslatorStyle = pluginVersion;
  styleElement.textContent = `
    .agy-tt-host {
      display: flex !important;
      flex-direction: column !important;
    }
    .agy-tt-host[data-agy-tt-active="true"] > div.overflow-y-auto {
      max-height: 320px !important;
    }
    .agy-tt-block {
      order: 20;
      margin: 2px 0 6px 10px;
      padding: 2px 8px 2px 12px;
      border-left: 2px solid color-mix(in srgb, var(--muted-foreground, #8b949e) 40%, transparent);
      color: var(--secondary-foreground, var(--foreground, #c9d1d9));
      opacity: 0.92;
      font-size: 13.5px;
      line-height: 1.62;
      font-style: italic;
      display: flex;
      flex-direction: column;
      gap: 7px;
      user-select: text;
      word-break: break-word;
    }
    .agy-tt-block[data-collapsed="true"] {
      display: none !important;
    }
    .agy-tt-para {
      margin: 0;
    }
    .agy-tt-para[data-status="pending"] {
      color: var(--muted-foreground, #8b949e);
      font-size: 12.5px;
      opacity: 0.78;
    }
    .agy-tt-para[data-status="streaming"]::after {
      content: " ▍";
      font-style: normal;
      opacity: 0.65;
      animation: agy-tt-blink 900ms steps(2, start) infinite;
    }
    .agy-tt-para[data-status="error"] {
      color: var(--muted-foreground, #8b949e);
      font-style: normal;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .agy-tt-retry-btn {
      appearance: none;
      border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
      background: var(--secondary, rgba(127, 127, 127, 0.12));
      color: var(--foreground, inherit);
      border-radius: 5px;
      padding: 1px 7px;
      font-size: 11.5px;
      cursor: pointer;
      line-height: 1.4;
    }
    .agy-tt-retry-btn:hover {
      opacity: 0.85;
    }
    .agy-tt-inline-code {
      font-style: normal;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9em;
      padding: 0.5px 4px;
      border-radius: 4px;
      background: color-mix(in srgb, var(--secondary, rgba(127, 127, 127, 0.16)) 85%, transparent);
    }
    .agy-tt-strong, .agy-tt-heading {
      font-weight: 600;
      color: var(--foreground, inherit);
    }
    .agy-tt-code-block {
      font-style: normal;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      margin: 4px 0;
      padding: 8px 10px;
      border-radius: 6px;
      background: var(--secondary, rgba(127, 127, 127, 0.12));
      overflow-x: auto;
      white-space: pre-wrap;
    }
    .agy-tt-live-status {
      color: var(--muted-foreground, #8b949e);
      font-size: 12px;
      opacity: 0.75;
    }
    @keyframes agy-tt-blink {
      to { visibility: hidden; }
    }
  `;
  (document.head || document.documentElement).appendChild(styleElement);

  function cleanupRemovedBlocks() {
    for (const block of document.querySelectorAll('.agy-tt-block')) {
      if (!settings.enabled) {
        block.parentElement?.classList.remove('agy-tt-host');
        delete block.parentElement?.dataset?.agyTtActive;
        block.remove();
      }
    }
  }

  function renderChineseBlockForTrigger(triggerButton, info) {
    const hostContainer = triggerButton.closest('div.relative') || triggerButton.parentElement;
    if (!hostContainer) return;

    hostContainer.classList.add('agy-tt-host');
    if (info.isActivelyThinking) {
      hostContainer.dataset.agyTtActive = 'true';
    } else {
      delete hostContainer.dataset.agyTtActive;
    }

    // Manage English thinking auto-expand while streaming & auto-collapse when done
    if (info.isActivelyThinking) {
      autoManagedActiveTriggers.add(triggerButton);
      if (
        settings.expandEnglishWhileThinking &&
        triggerButton.getAttribute('aria-expanded') === 'false' &&
        !userToggledTriggers.has(triggerButton)
      ) {
        triggerButton.click();
      }
    } else if (autoManagedActiveTriggers.has(triggerButton)) {
      autoManagedActiveTriggers.delete(triggerButton);
      if (
        settings.collapseEnglishWhenDone &&
        triggerButton.getAttribute('aria-expanded') === 'true' &&
        !userToggledTriggers.has(triggerButton)
      ) {
        triggerButton.click();
      }
    }

    const allParagraphs = splitThinkingParagraphs(info.thinking);
    const translatableParagraphs = (
      info.isActivelyThinking ? allParagraphs.slice(0, -1) : allParagraphs
    ).filter(shouldTranslateThinking);

    // Queue translations for completed paragraphs
    const itemEntries = translatableParagraphs.map(rawPara => {
      const clamped = clampParagraph(rawPara);
      const key = queueParagraphForTranslation(clamped) || sha256Key32(clamped);
      return { key, source: clamped, state: paragraphStateMap.get(key) };
    });

    const hasStreamingTail =
      info.isActivelyThinking &&
      allParagraphs.length > 0 &&
      shouldTranslateThinking(allParagraphs[allParagraphs.length - 1]);

    if (itemEntries.length === 0 && !hasStreamingTail) {
      const stale = hostContainer.querySelector(':scope > .agy-tt-block');
      if (stale) stale.remove();
      return;
    }

    let blockEl = hostContainer.querySelector(':scope > .agy-tt-block');
    if (!blockEl) {
      blockEl = document.createElement('div');
      blockEl.className = 'agy-tt-block';
      blockEl.dataset.agyThinkingTranslator = 'block';
      hostContainer.appendChild(blockEl);
    }

    const shouldCollapseChinese =
      !settings.keepChineseExpanded && collapsedChineseBlocks.has(triggerButton);
    blockEl.dataset.collapsed = String(shouldCollapseChinese);

    const desiredKeys = itemEntries.map(item => item.key);
    if (hasStreamingTail) desiredKeys.push('__live_tail__');

    // Reconcile children cleanly by key
    const existingByKey = new Map();
    for (const child of [...blockEl.children]) {
      const childKey = child.dataset.paraKey;
      if (childKey && desiredKeys.includes(childKey) && !existingByKey.has(childKey)) {
        existingByKey.set(childKey, child);
      } else {
        child.remove();
      }
    }

    for (let idx = 0; idx < itemEntries.length; idx++) {
      const { key, source, state } = itemEntries[idx];
      const status = state?.status || 'pending';
      const text = state?.translation || '';
      const error = state?.error || '';
      const signature = `${status}|${text}|${error}`;

      let paraEl = existingByKey.get(key);
      if (!paraEl) {
        paraEl = document.createElement('div');
        paraEl.className = 'agy-tt-para';
        paraEl.dataset.paraKey = key;
      }

      if (paraEl._renderedSig !== signature) {
        paraEl._renderedSig = signature;
        paraEl.dataset.status = status;
        paraEl.replaceChildren();

        if ((status === 'done' || status === 'streaming') && text) {
          populateParagraphContent(paraEl, text);
        } else if (status === 'error') {
          const msgSpan = document.createElement('span');
          msgSpan.textContent = `翻译未完成（${error || '本地 Magpie 未响应'}）`;
          const retryBtn = document.createElement('button');
          retryBtn.type = 'button';
          retryBtn.className = 'agy-tt-retry-btn';
          retryBtn.textContent = '重试';
          retryBtn.addEventListener('click', ev => {
            ev.stopPropagation();
            queueParagraphForTranslation(source, { forceRetry: true });
            scheduleDomSync();
          });
          paraEl.append(msgSpan, retryBtn);
        } else {
          paraEl.textContent = '正在调用 DS Flash 翻译思维链…';
        }
      }

      const currentAtIndex = blockEl.children[idx];
      if (currentAtIndex !== paraEl) {
        blockEl.insertBefore(paraEl, currentAtIndex || null);
      }
    }

    if (hasStreamingTail) {
      let tailEl = existingByKey.get('__live_tail__');
      if (!tailEl) {
        tailEl = document.createElement('div');
        tailEl.className = 'agy-tt-live-status';
        tailEl.dataset.paraKey = '__live_tail__';
        tailEl.textContent =
          itemEntries.length === 0
            ? '正在思考中（当前段落完成后即刻输出中文译文）…'
            : '正在继续思考下一段…';
      } else {
        const nextTailLabel =
          itemEntries.length === 0
            ? '正在思考中（当前段落完成后即刻输出中文译文）…'
            : '正在继续思考下一段…';
        if (tailEl.textContent !== nextTailLabel) {
          tailEl.textContent = nextTailLabel;
        }
      }
      if (blockEl.lastElementChild !== tailEl) {
        blockEl.appendChild(tailEl);
      }
    }
  }

  function syncAllThinkingBlocks() {
    if (disposed) return;
    ensureNativeHooks();

    if (!settings.enabled) {
      cleanupRemovedBlocks();
      return;
    }

    // Ensure already-mounted outer containers with thinking steps are expanded once
    if (settings.keepContainersExpanded) {
      const containerButtons = document.querySelectorAll(
        '[data-testid="worked-for-collapsible"][aria-expanded="false"], [data-testid="tool-group-collapsible"][aria-expanded="false"]'
      );
      for (const btn of containerButtons) {
        if (autoExpandedContainers.has(btn)) continue;
        if (containerHoldsThinking(btn)) {
          autoExpandedContainers.add(btn);
          btn.click();
        }
      }
    }

    const triggers = document.querySelectorAll(
      '[data-testid="thinking-collapsible-trigger"], button[aria-label^="Thought for "], button[aria-label="Thought Process"], button[aria-label="Thinking..."]'
    );

    for (const triggerBtn of triggers) {
      const info = extractThinkingInfoFromTrigger(triggerBtn);
      if (!info || !info.thinking) continue;
      renderChineseBlockForTrigger(triggerBtn, info);
    }
  }

  // Track genuine user clicks on thinking triggers so we never fight manual toggle
  const abortController = new AbortController();
  document.addEventListener(
    'click',
    event => {
      if (!event.isTrusted) return;
      const triggerBtn = event.target?.closest?.(
        '[data-testid="thinking-collapsible-trigger"], button[aria-label^="Thought for "], button[aria-label="Thought Process"], button[aria-label="Thinking..."]'
      );
      if (triggerBtn) {
        userToggledTriggers.add(triggerBtn);
      }
      const outerBtn = event.target?.closest?.(
        '[data-testid="worked-for-collapsible"], [data-testid="tool-group-collapsible"]'
      );
      if (outerBtn) {
        autoExpandedContainers.add(outerBtn);
      }
    },
    { capture: true, signal: abortController.signal }
  );

  const domObserver = new MutationObserver(() => {
    scheduleDomSync();
  });

  function startObserving() {
    if (disposed) return;
    const rootTarget = document.body || document.documentElement;
    if (!rootTarget) {
      setTimeout(startObserving, 100);
      return;
    }
    domObserver.observe(rootTarget, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-expanded', 'aria-label']
    });
    syncAllThinkingBlocks();
  }

  const periodicSyncTimer = setInterval(() => {
    if (!disposed) syncAllThinkingBlocks();
  }, 1200);

  // Sync latest settings from host on startup
  void callHost('settings.get')
    .then(latest => {
      if (latest && typeof latest === 'object' && !disposed) {
        settings = { ...DEFAULT_SETTINGS, ...latest };
        scheduleDomSync();
      }
    })
    .catch(() => {});

  ensureNativeHooks();
  startObserving();

  globalThis.__agyThinkingTranslator = {
    version: pluginVersion,
    get healthy() {
      return !disposed && Boolean(document.head && styleElement.isConnected);
    },
    get stats() {
      let renderedBlocks = 0;
      if (typeof document !== 'undefined') {
        renderedBlocks = document.querySelectorAll('.agy-tt-block').length;
      }
      return {
        version: pluginVersion,
        enabled: settings.enabled,
        cachedInRenderer: paragraphStateMap.size,
        renderedBlocks
      };
    },
    sync: syncAllThinkingBlocks,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(periodicSyncTimer);
      if (batchFlushTimer) clearTimeout(batchFlushTimer);
      abortController.abort();
      domObserver.disconnect();
      restoreNativeHooks();
      for (const [, pending] of pendingRpcCalls) {
        clearTimeout(pending.timer);
      }
      pendingRpcCalls.clear();
      for (const block of document.querySelectorAll('.agy-tt-block')) {
        block.parentElement?.classList.remove('agy-tt-host');
        delete block.parentElement?.dataset?.agyTtActive;
        block.remove();
      }
      styleElement.remove();
      delete globalThis.__agyThinkingTranslatorReceive;
      delete globalThis.__agyThinkingTranslatorPush;
      delete globalThis.__agyThinkingTranslator;
    }
  };
})();
