// Ember Voice, thread side.
//
// This runs inside every Claude Code session on this computer. It does
// nothing at all unless the Ember Voice bar is open in thread mode AND has
// named this exact session in its link file. Then it becomes the bar's hands
// in this thread: it types what the bar heard as the person's own message,
// hands words spoken mid-turn into the running turn, and tells the bar when a
// turn starts, each piece of text Claude writes as it works, and the reply.
//
// Everything goes to the bar over 127.0.0.1 with the token from the link
// file. Nothing is written to disk, and no reply text leaves this computer.
//
// The bar's side of this conversation is code/lib/thread-bridge.mjs.

const VERSION = '1.4.1'
const TICK_MS = 1000
// While not linked, the link file is only looked at every few ticks.
const LINK_EVERY_TICKS = 3
// After the bar failed to answer, wait longer before looking again.
const MAX_BACKOFF_TICKS = 15

let myId = null
let linkPath = null // '' when this computer has no place for one
let link = null // { port, token } while the bar is talking to this session
let ticks = 0
let nextLookTick = 0
let failures = 0
let isPolling = false
let runningTurn = null // the main loop's turn id while one runs
// The running turn's last model response has arrived and asked for no tools,
// so no further request will read anything: words now wait for a turn of
// their own instead of being handed in (and then sent a second time).
let closing = false
// Words handed into the running turn that no model request has read yet.
// Should the turn end first, they are sent again as a prompt of their own,
// so nothing you say is ever lost.
let unread = []
// What Claude has written so far this turn, already passed to the bar to
// speak, so the final reply is not spoken a second time.
let spokenThisTurn = []

// Each thread has its own link file (one bar per thread can be open at once):
// %APPDATA%/ember-voice/thread-links/<session id>.json
async function readLink($) {
  myId = await $.session.id()
  if (linkPath === null) {
    const appData = await $.env.get('APPDATA')
    linkPath = appData ? `${appData}/ember-voice/thread-links/${myId}.json` : ''
  }
  if (linkPath === '') return null
  let data
  try {
    data = JSON.parse(await $.fs.read(linkPath))
  } catch {
    // No bar for this thread: the usual case.
    return null
  }
  if (data === null || typeof data !== 'object') return null
  if (data.sessionId !== myId) return null
  if (!Number.isInteger(data.port) || typeof data.token !== 'string') return null
  return { port: data.port, token: data.token }
}

async function post($, target, path, body) {
  const response = await $.http.fetch(`http://127.0.0.1:${target.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ember-token': target.token },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`the bar answered ${response.status}`)
  return response.text ? JSON.parse(response.text) : {}
}

// Tells the bar something without ever holding up or failing the session.
async function report($, target, event) {
  try {
    await post($, target, '/event', { sessionId: myId, ...event })
  } catch {
    // The bar has gone; the next poll finds out.
  }
}

// Types one spoken message into this thread as the person's own words. The
// call waits for the session to be idle, so it is never awaited by a poll.
async function submit($, target, item) {
  let outcome
  try {
    const result = await $.prompt.submit({ text: item.text, asUser: true })
    outcome =
      result?.drop === undefined ? { type: 'submitted' } : { type: 'dropped', reason: String(result.drop) }
  } catch (error) {
    outcome = { type: 'dropped', reason: String(error?.message ?? error) }
  }
  await report($, target, { id: item.id, ...outcome })
}

// Spoken while Claude is working: added to the conversation at once as a
// user row, so the turn's next model request reads it (the way a message
// typed mid-turn arrives). A plugin's prompt would wait for the turn to end.
async function handIn($, target, item) {
  // When the hand-in began: a model request that starts after this reads it.
  const entry = { target, item, at: Date.now() }
  unread.push(entry)
  let result
  try {
    result = await $.session.append({
      message: {
        type: 'user',
        content: [{ type: 'text', text: `The user said this through Ember voice while you were working:\n${item.text}` }],
      },
    })
  } catch (error) {
    result = { deny: String(error?.message ?? error) }
  }
  if (result.deny !== undefined) {
    // Refused: send it as its own prompt instead.
    unread = unread.filter((other) => other !== entry)
    submit($, target, item)
    return
  }
  // The row Claude reads is hidden from you in the thread, so a transcript
  // line (which Claude never reads) shows you what was handed in. A stored
  // system notice was tried first: the desktop app does not draw those.
  try {
    $.ui.log(`🎙 You, through Ember: ${item.text}`)
  } catch {
    // Nowhere to draw it; Claude still has the words.
  }
  await report($, target, { id: item.id, type: 'submitted' })
}

// A model request is about to go out, built from the conversation as it
// stands: words handed in before it began are in it. (Judged by when the
// hand-in began, not when it was confirmed: a row can be read before the
// confirmation arrives, and was then sent a second time.)
function markRead(stepStartedAt) {
  unread = unread.filter((entry) => entry.at >= stepStartedAt)
}

function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

async function tick($) {
  if (isPolling) return
  isPolling = true
  try {
    ticks += 1
    if (link === null) {
      if (ticks < nextLookTick) return
      nextLookTick = ticks + LINK_EVERY_TICKS
      link = await readLink($)
      if (link === null) {
        failures = 0
        return
      }
    }
    const target = link
    let answer
    try {
      myId = await $.session.id()
      // The bar holds this open until it has something to say.
      answer = await post($, target, '/poll', {
        sessionId: myId,
        version: VERSION,
        isBusy: runningTurn !== null,
      })
      failures = 0
    } catch {
      // The bar closed or crashed. Back off, then read the link file again.
      failures += 1
      link = null
      nextLookTick = ticks + Math.min(failures * LINK_EVERY_TICKS, MAX_BACKOFF_TICKS)
      return
    }
    if (answer.unlink === true) {
      // The bar is now talking to another thread.
      link = null
      return
    }
    for (const item of answer.say ?? []) {
      if (!item || typeof item.text !== 'string' || item.text === '') continue
      if (runningTurn !== null && !closing) handIn($, target, item)
      else submit($, target, item)
    }
  } finally {
    isPolling = false
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    myId = await $.session.id()
    $.clock.every(TICK_MS, () => {
      tick($)
    })
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      runningTurn = e.turnId
      closing = false
      spokenThisTurn = []
      if (link !== null) report($, link, { type: 'turn-start' })
    }
    return next(e)
  })

  // Each piece of text Claude writes in the main loop goes to the bar as it
  // is kept, so it can be spoken while the turn carries on.
  on('session.append', async ($, e, next) => {
    const kept = await next(e)
    if (e.agentId === undefined && e.door === 'response' && runningTurn !== null && link !== null) {
      const text = textOf(kept?.message ?? e.message)
      if (text) {
        spokenThisTurn.push(text)
        report($, link, { type: 'progress', text })
      }
    }
    return kept
  })

  // A model request of the main loop reads everything handed in before it.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) markRead(Date.now())
    const result = yield* next(e)
    if (e.agentId === undefined && result && Array.isArray(result.toolUses) && result.toolUses.length === 0) closing = true
    return result
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      runningTurn = null
      closing = false
      // Handed in after the turn's last request: no request read them.
      const missed = unread
      unread = []
      for (const { target, item } of missed) submit($, target, item)
      const answer = e.reason === 'answer' ? e.answer : ''
      const spoken = answer !== '' && squash(spokenThisTurn.join(' ')).includes(squash(answer))
      spokenThisTurn = []
      if (link !== null) {
        report($, link, { type: 'turn-complete', reason: e.reason, text: answer, spoken })
      }
    }
    return next(e)
  })
}
