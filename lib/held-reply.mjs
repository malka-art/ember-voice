// A reply that arrived while you were talking is held back, so the bar does
// not talk over you. What happens to it once your sentence has been turned
// into text. Pure logic, shared by the window and the tests.
//
// It used to be spoken the moment you stopped, before your words were even
// transcribed; when they were then sent, it was cut off again a fraction of
// a second later, which showed as a little pink flash on the taskbar icon
// right after you finished talking. Now it waits for the outcome:
//   drop   your words went to the thread: the held reply is out of date
//   keep   you are already talking again: keep holding it
//   speak  nothing was sent (silence, noise, not for this bar): say it now
export function heldReplyAfterSentence({ sentToThread, stillTalking }) {
  if (sentToThread) return 'drop';
  if (stillTalking) return 'keep';
  return 'speak';
}
