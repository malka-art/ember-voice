// When the window picks up speech. Pure logic with no imports, shared by the
// window and the tests.
//
// Thread mode listens all the time: while Claude works, so you can add to or
// correct the request mid-turn, and while the widget speaks, so you can cut
// it off (its own voice coming back is caught in the main process). Other
// modes stay half-duplex: only your turn.
//
// It also listens while the last sentence is still being turned into text.
// It used to stop for that moment, which threw away the start of whatever you
// said next: "Ember." then a breath then "what is on today" lost "what is"
// whenever you started again before the text was back.
export function shouldListen({ connected, micOn, midTurn, turnActive, speaking, error }) {
  return Boolean(connected && micOn && !error && (midTurn || (!turnActive && !speaking)));
}
