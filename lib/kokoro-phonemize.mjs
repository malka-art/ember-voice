// Text to phonemes for the Kokoro voice model.
//
// Ported from kokoro-js (src/phonemize.js in github.com/hexgrad/kokoro,
// Apache-2.0, by Xenova and hexgrad) so the bar does not need kokoro-js, which
// pins an older @huggingface/transformers than the one this app already uses.
// The espeak-ng call is passed in, so this file has no dependencies and can be
// tested on its own.

function split(text, regex) {
  const result = [];
  let prev = 0;
  for (const match of text.matchAll(regex)) {
    const full = match[0];
    if (prev < match.index) result.push({ match: false, text: text.slice(prev, match.index) });
    if (full.length > 0) result.push({ match: true, text: full });
    prev = match.index + full.length;
  }
  if (prev < text.length) result.push({ match: false, text: text.slice(prev) });
  return result;
}

function splitNum(match) {
  if (match.includes('.')) return match;
  if (match.includes(':')) {
    const [h, m] = match.split(':').map(Number);
    if (m === 0) return `${h} o'clock`;
    if (m < 10) return `${h} oh ${m}`;
    return `${h} ${m}`;
  }
  const year = parseInt(match.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return match;
  const left = match.slice(0, 2);
  const right = parseInt(match.slice(2, 4), 10);
  const suffix = match.endsWith('s') ? 's' : '';
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

function flipMoney(match) {
  const bill = match[0] === '$' ? 'dollar' : 'pound';
  if (isNaN(Number(match.slice(1)))) return `${match.slice(1)} ${bill}s`;
  if (!match.includes('.')) return `${match.slice(1)} ${bill}${match.slice(1) === '1' ? '' : 's'}`;
  const [b, c] = match.slice(1).split('.');
  const d = parseInt(c.padEnd(2, '0'), 10);
  const coins = match[0] === '$' ? (d === 1 ? 'cent' : 'cents') : d === 1 ? 'penny' : 'pence';
  return `${b} ${bill}${b === '1' ? '' : 's'} and ${d} ${coins}`;
}

function pointNum(match) {
  const [a, b] = match.split('.');
  return `${a} point ${b.split('').join(' ')}`;
}

export function normalizeText(text) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, '“')
    .replace(/»/g, '”')
    .replace(/[“”]/g, '"')
    .replace(/\(/g, '«')
    .replace(/\)/g, '»')
    .replace(/、/g, ', ')
    .replace(/。/g, '. ')
    .replace(/！/g, '! ')
    .replace(/，/g, ', ')
    .replace(/：/g, ': ')
    .replace(/；/g, '; ')
    .replace(/？/g, '? ')
    .replace(/[^\S \n]/g, ' ')
    .replace(/  +/, ' ')
    .replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNum)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

const PUNCTUATION = ';:,.!?¡¿\u2014…"«»“”(){}[]';
const PUNCTUATION_PATTERN = new RegExp(`(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');

// `espeak(text, lang)` is phonemizer's phonemize(): resolves to an array of strings.
// `language` is the first letter of the voice name: "a" American, "b" British.
export async function phonemize(text, espeak, language = 'a') {
  const sections = split(normalizeText(text), PUNCTUATION_PATTERN);
  const lang = language === 'a' ? 'en-us' : 'en';
  const parts = await Promise.all(sections.map(async ({ match, text: t }) => (match ? t : (await espeak(t, lang)).join(' '))));
  let out = parts
    .join('')
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿\u2014…"«»“” ]|$)/g, 'z');
  if (language === 'a') out = out.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return out.trim();
}
