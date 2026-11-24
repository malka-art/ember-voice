// The words the speech model is told to expect before it hears a sentence
// (Whisper's "prompt"): every name a bar answers to, said the way you say
// them, so "Juniper, ..." is heard as a name, and then your own words from
// the `speechWords` setting (product names, people, odd spellings), so
// "illi" stops coming out as "Ellie" or "Illy".
//
// Kept short: Whisper reads only the last couple of hundred tokens of it, and
// a long prompt makes it more likely to copy the prompt into the text.
const MAX_WORDS = 40;
const MAX_CHARS = 400;

export function buildSpeechHint(names = [], words = []) {
  const seen = new Set();
  const out = [];
  const add = (word) => {
    const clean = String(word ?? '').replace(/\s+/g, ' ').trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key) || out.length >= MAX_WORDS) return;
    seen.add(key);
    out.push(clean);
  };
  // Names are capitalised; your own words keep the spelling you gave.
  for (const name of names) add(String(name ?? '').replace(/\b\w/g, (c) => c.toUpperCase()));
  for (const word of Array.isArray(words) ? words : []) add(word);
  let hint = out.length ? `${out.join(', ')}.` : '';
  while (hint.length > MAX_CHARS && out.length > 1) {
    out.pop();
    hint = `${out.join(', ')}.`;
  }
  return hint;
}
