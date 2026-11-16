// The wake word. With one set, the bar ignores everything it hears unless it
// starts with its name ("Ember, what is..."), the way Alexa and Siri do. After
// each exchange it keeps listening without the name for a short while, so a
// back-and-forth does not need the name on every sentence.
//
// In thread mode each thread can have its own bar, and each bar answers to
// its thread's name ("Juniper, ..."). "Ember" works only while one bar is
// open, and a sentence that starts with another open bar's name is never
// taken, even inside the no-name window.

// What the fast speech model tends to write when it hears each name.
const NEAR_MISSES = {
  ember: ['ember', 'embers', 'amber', 'ambers', 'umber', 'embar', 'emba', 'ember\'s', 'amber\'s'],
};

const GREETINGS = ['hey', 'hi', 'ok', 'okay', 'hello', 'yo'];

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A thread's name works as a wake word when it is short enough to say (one to
// three words, e.g. "Juniper"); longer titles are left out.
export function nameFromTitle(title) {
  const words = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  return words.length >= 1 && words.length <= 3 ? words.join(' ') : '';
}

// Matches a sentence that opens with one of `names` (after an optional
// greeting); null when there are none.
function patternFor(names) {
  const spoken = names
    .map((one) => String(one ?? '').trim().toLowerCase())
    .filter(Boolean)
    .flatMap((one) => NEAR_MISSES[one] ?? [one]);
  if (!spoken.length) return null;
  const alternatives = spoken.map((one) => escape(one).replace(/ /g, '\\W+')).join('|');
  // An optional greeting, a name, then whatever was actually asked.
  return new RegExp(`^\\W*(?:(?:${GREETINGS.join('|')})\\W+)?(?:${alternatives})(?![a-z])\\W*`, 'i');
}

// `word`: the wake word ('' = always listening). `also`: more names that wake
// it the same way. `others`: names of other open bars, never taken here.
export function createWakeGate({ word = '', followMs = 12000, also = [], others = [] } = {}) {
  const isOn = String(word ?? '').trim() !== '';
  let pattern = patternFor([word, ...also]);
  let othersPattern = patternFor(others);
  let openUntil = -Infinity;

  const forAnother = (text) => Boolean(othersPattern?.test(text));

  return {
    isOn,
    // Which names wake it now: the thread was renamed, or bars opened or closed.
    rename({ word: next = word, also: nextAlso = [], others: nextOthers = [] } = {}) {
      pattern = patternFor([next, ...nextAlso]);
      othersPattern = patternFor(nextOthers);
    },
    // How much longer the bar listens without its name, in ms (0 = asleep).
    // With no wake word set it is always awake.
    remaining(now = Date.now()) {
      if (!isOn) return Infinity;
      return Math.max(0, openUntil - now);
    },
    // Keeps the no-name window open: called when an exchange moves forward.
    touch(now = Date.now()) {
      if (isOn) openUntil = now + followMs;
    },
    // A look at a sentence still being spoken: whether it is meant for the bar
    // so far ({ awake, called, text }), so the bar can glow and show the words
    // before you have finished. It changes nothing, except that another bar's
    // name puts this one to sleep ({ other: true }).
    peek(heard, now = Date.now()) {
      const text = String(heard ?? '').trim();
      // Meant for another bar: this one goes to sleep at once (no glow, no
      // no-name window), so only the bar you named is listening.
      if (forAnother(text)) {
        openUntil = -Infinity;
        return { awake: false, called: false, text: '', other: true };
      }
      if (!isOn) return { awake: true, called: false, text };
      const match = pattern?.exec(text);
      if (match) {
        const rest = text.slice(match[0].length).trim();
        return { awake: true, called: true, text: rest.charAt(0).toUpperCase() + rest.slice(1) };
      }
      if (now <= openUntil) return { awake: true, called: false, text };
      return { awake: false, called: false, text: '' };
    },
    // Returns { text } to send on, { called: true } when only the name was
    // said, or { ignored: true } for speech that was not meant for the bar.
    check(heard, now = Date.now()) {
      const text = String(heard ?? '').trim();
      if (forAnother(text)) {
        openUntil = -Infinity;
        return { ignored: true, other: true };
      }
      if (!isOn) return { text };
      const match = pattern?.exec(text);
      if (match) {
        const rest = text.slice(match[0].length).trim();
        openUntil = now + followMs;
        if (rest === '') return { called: true };
        return { text: rest.charAt(0).toUpperCase() + rest.slice(1) };
      }
      if (now <= openUntil) {
        openUntil = now + followMs;
        return { text };
      }
      return { ignored: true };
    },
  };
}
