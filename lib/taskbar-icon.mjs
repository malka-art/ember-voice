// Which taskbar icon the bar shows (assets/ember-<name>.ico). Pure logic
// with no imports, shared by the window and the tests.
//   hear   you are talking to it, or it is turning what you said into text
//   speak  it is reading a reply aloud
//   idle   anything else, the orb with no glow
// Asleep, sound it picks up is not shown as hearing (the bar itself does not
// glow then either), so a TV in the room leaves the icon alone.
export function taskbarIconFor(state) {
  if (state === 'listening' || state === 'transcribing') return 'hear';
  if (state === 'speaking') return 'speak';
  return 'idle';
}

export const TASKBAR_ICONS = ['idle', 'hear', 'speak'];
