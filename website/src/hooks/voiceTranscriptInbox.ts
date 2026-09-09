/**
 * Module-scoped hand-off for a batch transcription that outlives the component
 * which started it.
 *
 * Navigating away from Chat unmounts the voice hook while the `/api/stt`
 * request is still in flight. The request is a plain fetch, so it completes
 * regardless — only its DELIVERY needs somewhere to land, because the callback
 * it was going to invoke belongs to a page that no longer exists. Progress and
 * results are routed here instead: to the hook instances that are mounted at the
 * time if there are any, otherwise held until the next instance subscribes.
 * That is what carries a transcript across a trip to Settings.
 *
 * Every request carries an id, and a subscriber is told when one BEGINS as well
 * as when it settles. Both exist for the same reason: an instance must be able
 * to tell "the request I am displaying as busy" from "some other request", so a
 * late settlement can never blank the state of a session that has started since.
 *
 * Deliberately NOT a mic owner and NOT a persistence layer: the microphone, the
 * MediaRecorder and the streaming socket still stop on unmount, so leaving Chat
 * never leaves a recording running without any UI to see or stop it. Only the
 * pending request lives here, and only until the tab unloads.
 *
 * One invariant, resting on the fact that the caller refuses to start a session
 * while a transcription is in flight: at most one request is ever waiting, so a
 * single result slot is enough.
 *
 * Subscribers are a SET, not a slot (chat-core P3-b). Every composer that can
 * dictate mounts its own voice hook — the main chat, each split pane, each Crew
 * Members DM — and they co-mount routinely (the session grid keeps ChatPage's
 * hook alive under N panes). `begin` fans out so every instance reads the same
 * global "a transcription is in flight" fact; that is what disables the mic on
 * every other composer while one is busy. `settle` releases busy on every
 * instance but delivers the TEXT once: to the instance whose composer owns the
 * session (`owns`), and only when none claims it, to every instance — the legacy
 * single-subscriber shape, which each host's own routing (ChatPage: append to
 * that slot's persisted draft; a pane: drop) then decides.
 */

/** A transcription request in flight. */
export interface PendingTranscription {
  id: number
  /** Slot that owned the recording, so the busy state shows on the right session. */
  sessionId: string | null
}

/** Terminal outcome of one request. Exactly one is delivered per `beginTranscription`. */
export interface TranscriptResult {
  /** Matches the `PendingTranscription` this settles. */
  id: number
  /** Transcribed text. Absent when the request failed or returned nothing. */
  text?: string
  /** Already-localized failure message, surfaced as the hook's `error`. */
  error?: string
  sessionId: string | null
}

export interface TranscriptSink {
  begin: (request: PendingTranscription) => void
  /**
   * `deliver` is false when another subscriber claimed the transcript: release
   * this instance's busy state for the request, surface an error if any, but do
   * NOT hand the text to the host — it would land in two composers.
   */
  settle: (result: TranscriptResult, deliver: boolean) => void
  /**
   * True when this subscriber's composer is the one on screen for `sessionId`.
   * Optional: a subscriber without it never claims and only receives the text on
   * the unclaimed fallback path.
   */
  owns?: (sessionId: string | null) => boolean
}

const sinks = new Set<TranscriptSink>()
/** Result waiting for a subscriber. A newer one replaces it: the invariant allows
 *  only one, and the newer utterance is the one a user still wants. */
let pending: TranscriptResult | null = null
let inFlight: PendingTranscription | null = null
let nextId = 0

/** Deliver one settled result to the live subscribers with single-owner text delivery. */
function dispatchSettle(result: TranscriptResult): void {
  const live = [...sinks]
  const owners = live.filter(s => s.owns?.(result.sessionId) === true)
  // A claimed transcript goes to exactly one composer. Several claimants means
  // two hosts both believe they show the session (ChatPage's hook under a split
  // pane of the same slot); the most recently subscribed one is the pane the
  // user is looking at, so it wins.
  const target = owners.length ? owners[owners.length - 1] : null
  for (const s of live) s.settle(result, target ? s === target : true)
}

/**
 * Register a delivery target. An already-running request is replayed as a
 * `begin` so a returning instance restores the busy indicator, and a result that
 * settled while no instance existed is handed over.
 *
 * The hand-over is deferred to a microtask rather than applied inline. A
 * subscriber mounts inside a page whose own prefill and draft effects commit in
 * the same pass, and a transcript applied before those have run is written
 * against composer state they are about to replace — so it lands in a
 * half-settled slot and can be overwritten by the very next persist. A microtask
 * runs after the whole effect flush, which is when the composer knows which slot
 * it holds.
 *
 * It delivers to whichever sinks are current when it runs, not to the one that
 * scheduled it: StrictMode subscribes, tears down and resubscribes within that
 * window, so keying on the scheduling subscription would strand the text on
 * every mount in development.
 */
export function subscribeTranscripts(next: TranscriptSink): () => void {
  sinks.add(next)
  if (inFlight) next.begin(inFlight)
  const handover = pending
  pending = null
  if (handover) {
    queueMicrotask(() => {
      // Nothing mounted any more: keep holding the text for the next instance
      // rather than delivering into sinks that are gone. A result that arrived
      // in the meantime is newer and wins.
      if (!sinks.size) { pending = pending ?? handover; return }
      dispatchSettle(handover)
    })
  }
  return () => { sinks.delete(next) }
}

/** Announce a started transcription and return its identity. */
export function beginTranscription(sessionId: string | null): PendingTranscription {
  inFlight = { id: ++nextId, sessionId }
  for (const s of sinks) s.begin(inFlight)
  return inFlight
}

/** Deliver a request's outcome to the live subscribers, or hold it for the next. */
export function settleTranscription(result: TranscriptResult): void {
  // Guarded so a straggler cannot clear a NEWER request's in-flight record and
  // leave a returning instance showing idle while that one is still running.
  if (inFlight?.id === result.id) inFlight = null
  if (sinks.size) { dispatchSettle(result); return }
  pending = result
}

/** Test seam: number of live subscribers. */
export function _subscriberCount(): number { return sinks.size }
