import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CACHE_PERSIST_DEBOUNCE_MS,
  MAX_DISK_CACHE_ENTRIES,
  MAX_MEMORY_CACHE_ENTRIES
} from './constants.mjs';
import { resolvePluginDataDirectory, writeJsonAtomically } from './settings.mjs';
import { computeParagraphKey } from './text-splitter.mjs';

export function createTranslationCache({
  dataDirectory = resolvePluginDataDirectory(),
  persistDebounceMs = CACHE_PERSIST_DEBOUNCE_MS
} = {}) {
  const cacheFilePath = join(dataDirectory, 'translations-cache.json');
  const memoryEntries = new Map();
  let persistTimer = null;
  let dirty = false;

  function loadInitialCache() {
    if (!existsSync(cacheFilePath)) return;
    try {
      const raw = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
      const entries = raw?.entries;
      if (!entries || typeof entries !== 'object') return;
      const sortedPairs = Object.entries(entries)
        .filter(([, record]) => typeof record?.translation === 'string' && record.translation.trim())
        .sort((a, b) => (Number(a[1]?.updatedAt) || 0) - (Number(b[1]?.updatedAt) || 0))
        .slice(-MAX_DISK_CACHE_ENTRIES);
      for (const [key, record] of sortedPairs) {
        memoryEntries.set(key, {
          translation: record.translation.trim(),
          updatedAt: Number(record.updatedAt) || Date.now()
        });
      }
    } catch {
      // Corrupted cache file is safely ignored and overwritten on next flush.
    }
  }

  function flushToDisk() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (!dirty) return;
    dirty = false;
    const recentPairs = [...memoryEntries.entries()].slice(-MAX_DISK_CACHE_ENTRIES);
    const serializedEntries = Object.fromEntries(recentPairs);
    try {
      writeJsonAtomically(cacheFilePath, {
        version: 1,
        updatedAt: Date.now(),
        entries: serializedEntries
      });
    } catch {
      // Disk persistence failure should never break live translation.
    }
  }

  function schedulePersist() {
    dirty = true;
    if (persistDebounceMs <= 0) {
      flushToDisk();
      return;
    }
    if (persistTimer) return;
    persistTimer = setTimeout(flushToDisk, persistDebounceMs);
    persistTimer.unref?.();
  }

  loadInitialCache();

  return {
    cacheFilePath,
    getByKey(paragraphKey) {
      const entry = memoryEntries.get(paragraphKey);
      if (!entry) return undefined;
      memoryEntries.delete(paragraphKey);
      memoryEntries.set(paragraphKey, entry);
      return entry.translation;
    },
    get(paragraphSourceText) {
      if (typeof paragraphSourceText !== 'string' || !paragraphSourceText.trim()) return undefined;
      return this.getByKey(computeParagraphKey(paragraphSourceText));
    },
    setByKey(paragraphKey, translatedText) {
      assert.equal(typeof paragraphKey, 'string', 'paragraphKey must be a string');
      const cleaned = typeof translatedText === 'string' ? translatedText.trim() : '';
      if (!cleaned) return;
      if (memoryEntries.has(paragraphKey)) {
        memoryEntries.delete(paragraphKey);
      }
      memoryEntries.set(paragraphKey, {
        translation: cleaned,
        updatedAt: Date.now()
      });
      while (memoryEntries.size > MAX_DISK_CACHE_ENTRIES) {
        const oldestKey = memoryEntries.keys().next().value;
        if (!oldestKey) break;
        memoryEntries.delete(oldestKey);
      }
      schedulePersist();
    },
    set(paragraphSourceText, translatedText) {
      if (typeof paragraphSourceText !== 'string' || !paragraphSourceText.trim()) return undefined;
      const key = computeParagraphKey(paragraphSourceText);
      this.setByKey(key, translatedText);
      return key;
    },
    getManyByKeys(keys = []) {
      const found = {};
      for (const key of keys) {
        if (typeof key !== 'string') continue;
        const value = this.getByKey(key);
        if (value) found[key] = value;
      }
      return found;
    },
    stats() {
      return {
        totalCachedParagraphs: memoryEntries.size,
        maxMemoryEntries: MAX_MEMORY_CACHE_ENTRIES,
        maxDiskEntries: MAX_DISK_CACHE_ENTRIES,
        cacheFilePath
      };
    },
    clear() {
      memoryEntries.clear();
      dirty = true;
      flushToDisk();
    },
    flush: flushToDisk
  };
}
