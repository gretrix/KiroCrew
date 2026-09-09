import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/* chat-core P3-b: every composer that can dictate mounts its own
 * `useComposerVoice`, and the engine underneath (`useVoiceInput`) is per
 * instance — so nothing in the engine stops two panes from opening two
 * captures. The hook's module-level owner slot is what makes the microphone
 * exclusive across instances. These tests pin that contract with two hook
 * instances sharing one fake engine factory. */

type Engine = {
  recording: boolean; transcribing: boolean; sessionOwner: string | null; streamEnabled: boolean
  toggle: () => void; start: () => Promise<void>; stop: () => void; cancel: () => void; prewarm: () => void
  error: string | null; level: number; deviceLabel: string; deviceId: string; clearError: () => void; partial: string
  download: null; sampleRef: { current: object }; switchDevice: () => void; deviceSwitchIsLive: boolean
}
// Hoisted so the mock factories (which vitest runs when the hoisted imports
// load) can reach the fixture without a temporal-dead-zone read.
const fx = vi.hoisted(() => {
  const engines: Engine[] = []
  // Which wrapper is rendering: the hook under test calls `useVoiceInput` once
  // per render, and the fake keys the engine on this index so each instance
  // keeps ONE engine object across its renders (the real hook relies on that).
  const state = { renderingInstance: 0 }
  function makeEngine(): Engine {
    const e: Engine = {
      recording: false, transcribing: false, sessionOwner: null, streamEnabled: false,
      toggle: vi.fn(), start: vi.fn(async () => { e.recording = true }), stop: vi.fn(() => { e.recording = false }), cancel: vi.fn(), prewarm: vi.fn(),
      error: null, level: 0, deviceLabel: '', deviceId: '', clearError: vi.fn(), partial: '',
      download: null, sampleRef: { current: {} }, switchDevice: vi.fn(), deviceSwitchIsLive: false,
    }
    return e
  }
  function engineFor(idx: number): Engine {
    if (!engines[idx]) engines[idx] = makeEngine()
    return engines[idx]
  }
  return { engines, state, engineFor }
})
const engines = fx.engines
vi.mock('../../hooks/useVoiceInput', () => ({
  useVoiceInput: () => fx.engineFor(fx.state.renderingInstance),
  voiceInputSupported: true,
}))
vi.mock('../../hooks/usePushToTalk', () => ({ usePushToTalk: () => undefined }))
vi.mock('../../api/client', () => ({
  api: { sttConfig: vi.fn().mockResolvedValue({ enabled: true, available: true, streaming: false, dictation_panel: true, provider: 'local' }) },
}))

import { useComposerVoice, _resetMicOwner } from './useComposerVoice'

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function mountInstance(idx: number, sessionId: string) {
  const inputRef = { current: '' }
  return renderHook(() => {
    fx.state.renderingInstance = idx
    return useComposerVoice({ sessionId, inputRef, setInput: (v: string) => { inputRef.current = v } })
  }, { wrapper })
}

async function settleConfig(...hooks: ReturnType<typeof mountInstance>[]) {
  // The STT config query must resolve before startVoice will do anything but
  // open the setup modal.
  await act(async () => { await Promise.resolve() })
  for (const h of hooks) await act(async () => { await vi.waitFor(() => expect(h.result.current.setup.open).toBe(false)) })
}

beforeEach(() => { engines.length = 0; _resetMicOwner() })

describe('useComposerVoice — one microphone across instances', () => {
  it('a second composer cannot start while the first holds the capture, and reads busy', async () => {
    const a = mountInstance(0, 'slot-a')
    const b = mountInstance(1, 'slot-b')
    await settleConfig(a, b)

    await act(async () => { await a.result.current.startVoice() })
    expect(engines[0].start).toHaveBeenCalledTimes(1)
    // Re-render A so its engine's `recording: true` is observed.
    a.rerender()
    b.rerender()
    expect(b.result.current.micBusyElsewhere).toBe(true)
    expect(a.result.current.micBusyElsewhere).toBe(false)

    await act(async () => { await b.result.current.startVoice() })
    // Refused: B's engine was never asked to start.
    expect(engines[1].start).not.toHaveBeenCalled()
    // And B's setup modal did NOT open — the refusal is a busy mic, not a config problem.
    expect(b.result.current.setup.open).toBe(false)
  })

  it('releases the capture once the owner is idle again, so the other composer may start', async () => {
    const a = mountInstance(0, 'slot-a')
    const b = mountInstance(1, 'slot-b')
    await settleConfig(a, b)

    await act(async () => { await a.result.current.startVoice() })
    a.rerender(); b.rerender()
    expect(b.result.current.micBusyElsewhere).toBe(true)

    act(() => { a.result.current.stopVoice() })
    expect(engines[0].stop).toHaveBeenCalledTimes(1)
    // The engine reports idle; the owner slot is released on A's next render.
    a.rerender(); b.rerender()
    expect(b.result.current.micBusyElsewhere).toBe(false)

    await act(async () => { await b.result.current.startVoice() })
    expect(engines[1].start).toHaveBeenCalledTimes(1)
  })

  it('a start that fails leaves nothing held', async () => {
    const a = mountInstance(0, 'slot-a')
    const b = mountInstance(1, 'slot-b')
    await settleConfig(a, b)
    // Permission denied: the engine never flips `recording` and reports an error.
    ;(engines[0].start as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { engines[0].error = 'denied' })

    await act(async () => { await a.result.current.startVoice() })
    a.rerender(); b.rerender()
    expect(b.result.current.micBusyElsewhere).toBe(false)
    await act(async () => { await b.result.current.startVoice() })
    expect(engines[1].start).toHaveBeenCalledTimes(1)
  })

  it('unmounting the owner releases the capture', async () => {
    const a = mountInstance(0, 'slot-a')
    const b = mountInstance(1, 'slot-b')
    await settleConfig(a, b)
    await act(async () => { await a.result.current.startVoice() })
    a.rerender(); b.rerender()
    expect(b.result.current.micBusyElsewhere).toBe(true)
    a.unmount()
    b.rerender()
    expect(b.result.current.micBusyElsewhere).toBe(false)
  })

  it('exposes the busy fact to ChatInput as voiceTranscribeActive so the other mic renders disabled', async () => {
    const { composerVoiceInputProps } = await import('./useComposerVoice')
    const a = mountInstance(0, 'slot-a')
    const b = mountInstance(1, 'slot-b')
    await settleConfig(a, b)
    await act(async () => { await a.result.current.startVoice() })
    a.rerender(); b.rerender()
    const bProps = composerVoiceInputProps(b.result.current)
    expect(bProps.voiceTranscribeActive).toBe(true)
    // Presentational state stays per-owner: B is not itself recording.
    expect(bProps.voiceRecording).toBe(false)
    // And B's prewarm is withheld — a pointer-down must not open a second stream.
    expect(bProps.onVoicePrewarm).toBeUndefined()
  })
})
