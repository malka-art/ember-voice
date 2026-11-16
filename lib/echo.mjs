// Tells your voice from the bar's own. While the bar speaks, the microphone
// stays open so you can cut in; what it hears then may be its own voice
// coming back through a speaker. That is caught by comparing word pairs: an
// echo repeats runs of what was just said, your own words rarely do, even
// when they share common single words ("I want you to...").
//
//   const memory = createSpokenMemory()
//   memory.remember(text)              each piece the bar is asked to speak
//   memory.isEcho(heard)               true when `heard` repeats it
//
// Pure logic with an injectable clock, for the tests.

const KEEP_MS = 120000;
const ECHO_SHARE = 0.5; // of your word pairs found in what was spoken

function wordsOf(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

function pairsOf(words) {
  const pairs = [];
  for (let i = 0; i + 1 < words.length; i++) pairs.push(`${words[i]} ${words[i + 1]}`);
  return pairs;
}

export function looksLikeEcho(heard, spokenTexts) {
  const pairs = pairsOf(wordsOf(heard));
  // One or two words ("okay, stop") are always taken as hers.
  if (pairs.length < 2) return false;
  const said = new Set(spokenTexts.flatMap((text) => pairsOf(wordsOf(text))));
  const found = pairs.filter((pair) => said.has(pair)).length;
  return found / pairs.length >= ECHO_SHARE;
}

export function createSpokenMemory({ now = () => Date.now(), keepMs = KEEP_MS } = {}) {
  let items = [];
  const prune = () => {
    const cutoff = now() - keepMs;
    items = items.filter((item) => item.at >= cutoff);
  };
  return {
    remember(text) {
      if (!text) return;
      prune();
      items.push({ text: String(text), at: now() });
    },
    isEcho(heard) {
      prune();
      return looksLikeEcho(
        heard,
        items.map((item) => item.text),
      );
    },
  };
}
