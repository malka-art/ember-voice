// Cuts a sentence into pieces the neural voice can start on quickly.
// Pure logic with no imports, so the window and the tests can both use it.
//
// Synthesis time grows with length (about 0.3 s per second of speech on this
// PC), so only the first piece of a reply needs to be short: later pieces are
// made while earlier ones are playing.

const BREAK_AFTER = /(?<=[,;:\u2014])\s+/;
const BREAK_BEFORE = /\s+(?=(?:and|but|so|because|which|then|or|while|since|until)\s)/gi;

export function splitForSpeech(sentence, { maxChars = 160, minChars = 20 } = {}) {
  const text = String(sentence ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  // First at punctuation, merging pieces that would be too short to sound natural.
  const out = [];
  for (const piece of text.split(BREAK_AFTER)) {
    const last = out.at(-1);
    if (last !== undefined && (last.length < minChars || piece.length < minChars) && last.length + piece.length + 1 <= maxChars) {
      out[out.length - 1] = `${last} ${piece}`;
    } else {
      out.push(piece);
    }
  }
  return out.flatMap((piece) => cutLong(piece, maxChars, minChars));
}

// A piece with no punctuation is cut before a joining word ("and", "so"...),
// and only failing that at the last space before the limit.
function cutLong(piece, maxChars, minChars) {
  const parts = [];
  let rest = piece;
  while (rest.length > maxChars) {
    let cut = -1;
    for (const m of rest.matchAll(BREAK_BEFORE)) {
      // "The build is slow / because..." is a fine place to breathe even if short.
      if (m.index >= Math.min(minChars, 12) && m.index <= maxChars) cut = m.index;
    }
    if (cut === -1) cut = rest.lastIndexOf(' ', maxChars);
    if (cut <= 0) break;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  parts.push(rest);
  return parts;
}
