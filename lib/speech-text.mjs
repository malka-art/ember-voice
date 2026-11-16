// Turns a stream of reply text into speakable sentences. Pure logic, shared
// by the renderer and the tests.

// Remove things that sound bad when read aloud.
export function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export class SentenceStream {
  constructor() {
    this.buffer = '';
  }

  // Add streamed text; returns the sentences that are now complete.
  feed(delta) {
    this.buffer += delta;
    return this.#drain(false);
  }

  // Call when the reply has finished; returns whatever is left.
  flush() {
    return this.#drain(true);
  }

  reset() {
    this.buffer = '';
  }

  #drain(final) {
    const out = [];

    for (;;) {
      // Hold back while a code block is still open, so it is skipped whole.
      const fences = (this.buffer.match(/```/g) || []).length;
      if (fences % 2 === 1 && !final) break;

      const cut = findBoundary(this.buffer);
      if (cut === -1) break;
      const sentence = cleanForSpeech(this.buffer.slice(0, cut));
      this.buffer = this.buffer.slice(cut);
      if (sentence) out.push(sentence);
    }

    if (final) {
      const rest = cleanForSpeech(this.buffer);
      this.buffer = '';
      if (rest) out.push(rest);
    }
    return out;
  }
}

// Index just past the first sentence end, or -1 if none is complete yet.
function findBoundary(text) {
  let inFence = false;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('```', i)) {
      inFence = !inFence;
      i += 2;
      if (!inFence) {
        // A closed code block ends a spoken unit.
        return i + 1;
      }
      continue;
    }
    if (inFence) continue;

    const ch = text[i];
    if (ch === '\n' && text[i + 1] === '\n') return i + 2;
    if (ch === '.' || ch === '!' || ch === '?') {
      const next = text[i + 1];
      if (next === undefined) return -1; // could still be "3.5" or "..."
      if (/\s/.test(next)) {
        // Skip decimals, list numbers ("1. ") and common abbreviations.
        const before = text.slice(Math.max(0, i - 4), i);
        if (ch === '.' && /(^|\s)\d{1,2}$/.test(before)) continue;
        if (ch === '.' && /(^|[\s(])(e\.g|i\.e|vs|Mr|Mrs|Dr)$/i.test(before)) continue;
        return i + 1;
      }
    }
  }
  return -1;
}
