import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CJK_SKIP_RATIO_THRESHOLD, MAX_SOURCE_PARAGRAPH_LENGTH } from './constants.mjs';

const FENCE_OPEN_REGEX = /^\s{0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_ONLY_REGEX = /^\s{0,3}(?:`+|~+)\s*$/;
const STANDALONE_HEADING_REGEX = /^#{1,6}\s+\S[^\n]*$/;
const FENCED_BLOCK_STRIP_REGEX = /^\s{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s{0,3}\1\s*$/gm;
const INLINE_CODE_STRIP_REGEX = /`[^`\n]+`/g;
const ASCII_LETTER_REGEX = /[a-zA-Z]/;
const CJK_CHARACTER_REGEX = /[\u4e00-\u9fff]/g;
const NON_WHITESPACE_REGEX = /\S/g;

export function normalizeThinkingText(rawText) {
  if (typeof rawText !== 'string') return '';
  return rawText.replace(/\r\n/g, '\n').trim();
}

export function splitThinkingParagraphs(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return [];
  const normalizedLines = rawText.replace(/\r\n/g, '\n').split('\n');
  const rawParagraphs = [];
  let currentLines = [];
  let activeFenceMarker = null;

  const flushCurrent = () => {
    const joinedParagraph = currentLines.join('\n').trim();
    if (joinedParagraph) {
      rawParagraphs.push(joinedParagraph);
    }
    currentLines = [];
  };

  for (const line of normalizedLines) {
    const fenceMatch = line.match(FENCE_OPEN_REGEX);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!activeFenceMarker) {
        activeFenceMarker = marker;
      } else if (
        marker[0] === activeFenceMarker[0] &&
        marker.length >= activeFenceMarker.length &&
        FENCE_CLOSE_ONLY_REGEX.test(line)
      ) {
        activeFenceMarker = null;
      }
      currentLines.push(line);
      continue;
    }

    if (!activeFenceMarker && line.trim() === '') {
      flushCurrent();
      continue;
    }

    currentLines.push(line);
  }
  flushCurrent();

  const mergedParagraphs = [];
  for (let index = 0; index < rawParagraphs.length; index++) {
    const paragraph = rawParagraphs[index];
    if (STANDALONE_HEADING_REGEX.test(paragraph) && index + 1 < rawParagraphs.length) {
      rawParagraphs[index + 1] = `${paragraph}\n\n${rawParagraphs[index + 1]}`;
    } else {
      mergedParagraphs.push(paragraph);
    }
  }

  return mergedParagraphs;
}

export function shouldTranslateThinking(paragraphText) {
  if (typeof paragraphText !== 'string') return false;
  const withoutFencedCode = paragraphText.replace(FENCED_BLOCK_STRIP_REGEX, '');
  const withoutInlineCode = withoutFencedCode.replace(INLINE_CODE_STRIP_REGEX, '');
  const strippedText = withoutInlineCode.trim();
  if (!strippedText || !ASCII_LETTER_REGEX.test(strippedText)) {
    return false;
  }

  const nonWhitespaceMatches = strippedText.match(NON_WHITESPACE_REGEX);
  const cjkMatches = strippedText.match(CJK_CHARACTER_REGEX);
  if (nonWhitespaceMatches && cjkMatches) {
    const cjkRatio = cjkMatches.length / nonWhitespaceMatches.length;
    if (cjkRatio >= CJK_SKIP_RATIO_THRESHOLD) {
      return false;
    }
  }

  return true;
}

export function clampSourceParagraph(paragraphText) {
  assert.equal(typeof paragraphText, 'string', 'paragraphText must be a string');
  const normalized = normalizeThinkingText(paragraphText);
  if (normalized.length <= MAX_SOURCE_PARAGRAPH_LENGTH) {
    return normalized;
  }
  return normalized.slice(0, MAX_SOURCE_PARAGRAPH_LENGTH);
}

export function computeParagraphKey(paragraphText) {
  const normalized = clampSourceParagraph(paragraphText);
  assert.ok(normalized.length > 0, 'Cannot compute key for empty paragraph');
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32);
}
