import { describe, it, expect, vi, beforeEach } from 'vitest'
import { subscribeTranscripts, beginTranscription, settleTranscription, _subscriberCount, type TranscriptSink } from './voiceTranscriptInbox'

/* chat-core P3-b: the inbox used to hold ONE subscriber (the later mount
 * silently detached the earlier). Composers now co-mount — ChatPage's hook stays
 * alive under N split panes, the Members page mounts a pane per DM — so it is a
 * set: `begin` fans out (every mic reads the same in-flight fact), `settle`
 * releases busy everywhere but delivers the TEXT once, to the subscriber whose
 * composer owns the session, falling back to everyone only when none claims. */

function sink(owns?: (id: string | null) => boolean): TranscriptSink & { begins: number[]; settles: Array<[number, boolean]> } {
  const s = {
    begins: [] as number[],
    settles: [] as Array<[number, boolean]>,
    begin: vi.fn((r: { id: number }) => { s.begins.push(r.id) }),
    settle: vi.fn((r: { id: number }, deliver: boolean) => { s.settles.push([r.id, deliver]) }),
    owns,
  }
  return s
}

const unsubs: Array<() => void> = []
beforeEach(() => {
  while (unsubs.length) unsubs.pop()!()
  expect(_subscriberCount()).toBe(0)
})

describe('voiceTranscriptInbox — many subscribers, one delivery', () => {
  it('a later subscriber no longer detaches an earlier one', () => {
    const a = sink(); const b = sink()
    unsubs.push(subscribeTranscripts(a), subscribeTranscripts(b))
    expect(_subscriberCount()).toBe(2)
    const req = beginTranscription('slot-a')
    expect(a.begins).toEqual([req.id])
    expect(b.begins).toEqual([req.id])
  })

  it('delivers the text to the owner only and releases busy on every subscriber', () => {
    const page = sink(id => id === 'slot-a')      // ChatPage showing slot-a
    const paneA = sink(id => id === 'slot-a')     // a split pane of the same slot
    const paneB = sink(id => id === 'slot-b')
    unsubs.push(subscribeTranscripts(page), subscribeTranscripts(paneA), subscribeTranscripts(paneB))
    const req = beginTranscription('slot-a')
    settleTranscription({ id: req.id, text: 'hello', sessionId: 'slot-a' })
    // Two claimants: the most recently subscribed (the pane the user is looking
    // at) wins; the page releases busy but must not also splice the text.
    expect(paneA.settles).toEqual([[req.id, true]])
    expect(page.settles).toEqual([[req.id, false]])
    expect(paneB.settles).toEqual([[req.id, false]])
  })

  it('falls back to delivering everywhere when no subscriber claims the session', () => {
    const a = sink(id => id === 'slot-x'); const b = sink()
    unsubs.push(subscribeTranscripts(a), subscribeTranscripts(b))
    const req = beginTranscription('slot-gone')
    settleTranscription({ id: req.id, text: 'late', sessionId: 'slot-gone' })
    expect(a.settles).toEqual([[req.id, true]])
    expect(b.settles).toEqual([[req.id, true]])
  })

  it('holds a result that settles with nobody mounted and hands it to the next subscriber', async () => {
    const req = beginTranscription('slot-a')
    settleTranscription({ id: req.id, text: 'kept', sessionId: 'slot-a' })
    const a = sink(id => id === 'slot-a')
    unsubs.push(subscribeTranscripts(a))
    await new Promise<void>(r => queueMicrotask(r))
    expect(a.settles).toEqual([[req.id, true]])
  })

  it('unsubscribing removes only that subscriber', () => {
    const a = sink(); const b = sink()
    const ua = subscribeTranscripts(a)
    unsubs.push(subscribeTranscripts(b))
    ua()
    expect(_subscriberCount()).toBe(1)
    const req = beginTranscription('slot-a')
    expect(a.begins).toEqual([])
    expect(b.begins).toEqual([req.id])
  })
})
