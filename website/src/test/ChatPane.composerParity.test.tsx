import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ComponentProps, ReactNode } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import type { RootState } from '../store'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from '../hooks/useTheme'
import chatReducer from '../store/chatSlice'
import dashboardReducer from '../store/dashboardSlice'
import notificationsReducer from '../store/notificationsSlice'
import type ChatInputComponent from '../components/ChatInput'

/* chat-core P3-b (#9775): ChatPane mounts the same ChatInput as ChatPage but
 * wired only 35 of its 110 props — no microphone, no long-paste collapse, no
 * @-mention picker. These tests pin the parity slice: after mount, ChatInput
 * receives the full voice prop set from `useComposerVoice`, the paste-block
 * pair, the @-mention staging callbacks, and the user's send-key mode; and an
 * image paste (ChatInput's handlePaste hands files to `onUploadFiles`) lands in
 * the pane's attachment strip. */

type ChatInputProps = ComponentProps<typeof ChatInputComponent>

/** Last props ChatInput was rendered with — the pane's wiring, observed. */
const captured: { props: ChatInputProps | null } = { props: null }

vi.mock('../components/ChatInput', () => ({
  default: (props: ChatInputProps) => { captured.props = props; return <div data-testid="chat-input-stub" /> },
}))
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent }: { data?: unknown[]; itemContent: (index: number, item: unknown) => ReactNode }) => (
    <div data-testid="virtuoso">{data?.map((d: unknown, i: number) => <div key={i}>{itemContent(i, d)}</div>)}</div>
  ),
}))
vi.mock('../api/client', () => ({
  api: {
    chatSlots: vi.fn().mockResolvedValue([]),
    chatSlotDetail: vi.fn().mockResolvedValue({ messages: [], running: false, has_more: false, total: 0 }),
    sendChat: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) }),
    chatHistory: vi.fn().mockResolvedValue({ sessions: [] }),
    models: vi.fn().mockResolvedValue([]),
    agents: vi.fn().mockResolvedValue([]),
    agentDetail: vi.fn().mockResolvedValue({}),
    workspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    spawnList: vi.fn().mockResolvedValue({ agents: [] }),
    uploadFiles: vi.fn().mockResolvedValue({ paths: ['/tmp/uploads/pasted.png'] }),
    screenshot: vi.fn().mockResolvedValue({ path: null }),
    fileSearch: vi.fn().mockResolvedValue({ root: '/repo', results: [] }),
    chatSlotAgent: vi.fn().mockResolvedValue(undefined),
    dashboardConfig: vi.fn().mockResolvedValue({ quick_send: false }),
    planAction: vi.fn().mockResolvedValue({ ok: true }),
    sttConfig: vi.fn().mockResolvedValue({ enabled: true, available: true, streaming: false, dictation_panel: true, provider: 'local' }),
  },
  SEARCH_MIN_CHARS: 2,
  ApiError: class ApiError extends Error {
    status: number
    body: string
    constructor(status: number, message: string, body = '') {
      super(message)
      this.name = 'ApiError'
      this.status = status
      this.body = body
    }
  },
}))
// A complete engine stand-in: the hook under test reads every member the real
// `useVoiceInput` returns, so a partial fake would throw on mount rather than
// prove anything about the wiring.
const engine = {
  recording: false, transcribing: false, sessionOwner: null as string | null, streamEnabled: false,
  toggle: vi.fn(), start: vi.fn().mockResolvedValue(undefined), stop: vi.fn(), cancel: vi.fn(), prewarm: vi.fn(),
  error: null as string | null, level: 0, deviceLabel: '', deviceId: '', clearError: vi.fn(), partial: '',
  download: null, sampleRef: { current: {} }, switchDevice: vi.fn(), deviceSwitchIsLive: false,
}
vi.mock('../hooks/useVoiceInput', () => ({ useVoiceInput: () => engine, voiceInputSupported: true }))
vi.mock('../hooks/usePushToTalk', () => ({ usePushToTalk: () => undefined }))
vi.mock('../hooks/useBranding', () => ({ useBranding: () => ({ botName: 'Test', avatar: '' }) }))
vi.mock('../hooks/useAgents', () => ({ useAgents: () => ({ agents: [{ name: 'default' }], defaultAgent: 'default' }) }))
vi.mock('../components/MarkdownRenderer', () => ({ default: ({ content }: { content: string }) => <span>{content}</span> }))
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribeLogs: () => {} }) }))
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }))

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
})

import ChatPane from '../components/ChatPane'
import { api } from '../api/client'

const SLOT = 'chat-1-parity'

function makeStore(slotKey: string) {
  return configureStore({
    reducer: { dashboard: dashboardReducer, chat: chatReducer, notifications: notificationsReducer },
    preloadedState: {
      dashboard: {
        status: null, connected: true,
        slots: [{ key: slotKey, messages: 0, running: false, mode: '', pending_approval: false, waiting_for_input: false, last_activity_ts: undefined, project: '/repo' }],
        unreadSlots: [], refreshTrigger: 0, approvalMode: 'normal',
        subagentRunning: {}, subagentDetails: {}, subagentText: {},
      } as unknown as RootState['dashboard'],
    } as Partial<RootState>,
  })
}

async function renderPane() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const store = makeStore(SLOT)
  await act(async () => {
    render(
      <Provider store={store}>
        <QueryClientProvider client={qc}>
          <ThemeProvider>
            <MemoryRouter>
              <ChatPane slotKey={SLOT} />
            </MemoryRouter>
          </ThemeProvider>
        </QueryClientProvider>
      </Provider>,
    )
  })
  await waitFor(() => expect(captured.props).not.toBeNull())
  return store
}

const props = () => captured.props as ChatInputProps

beforeEach(() => { captured.props = null; localStorage.clear() })

describe('ChatPane composer parity (chat-core P3-b)', () => {
  it('hands ChatInput the full voice prop set from useComposerVoice', async () => {
    await renderPane()
    const p = props()
    // Every handler ChatInput's mic button, hold gesture, Esc cancel and device
    // picker call must be a function — a missing one hides the affordance.
    for (const k of ['onVoiceToggle', 'onVoiceCancel', 'onVoicePrewarm', 'onVoiceStart', 'onVoiceStop', 'onSelectVoiceDevice', 'onClearVoiceError'] as const) {
      expect(typeof p[k], k).toBe('function')
    }
    // State props are present with their idle values (not undefined — an
    // omitted prop is how the pane used to render no mic at all).
    expect(p.voiceRecording).toBe(false)
    expect(p.voiceTranscribing).toBe(false)
    expect(p.voiceTranscribeActive).toBe(false)
    expect(p.voiceCaptureActive).toBe(false)
    expect(p.voiceLevel).toBe(0)
    expect(p.voiceDictationPanel).toBe(true)
    expect(p.voiceStreaming).toBe(false)
    expect(p.voiceSampleRef).toBe(engine.sampleRef)
    // Caret refs are how dictation splices at the cursor instead of appending.
    expect(p.voiceCaretRef).toEqual({ current: null })
    expect(p.voicePendingCaretRef).toEqual({ current: null })
  })

  it('the mic toggle starts the engine through the hook (not a dead prop)', async () => {
    await renderPane()
    await act(async () => { await props().onVoiceToggle?.() })
    expect(engine.start).toHaveBeenCalledTimes(1)
  })

  it('wires the long-paste collapse pair, the @-mention staging callbacks and the send-key mode', async () => {
    await renderPane()
    const p = props()
    expect(Array.isArray(p.pasteBlocks)).toBe(true)
    expect(typeof p.onPasteBlocksChange).toBe('function')
    // The FilePickerMenu renders only when onFileSelect is supplied.
    expect(typeof p.onFileSelect).toBe('function')
    expect(typeof p.onRemoveDir).toBe('function')
    expect(p.pendingDirs).toEqual([])
    // Default chatConfig send mode reaches the composer (was always 'enter').
    expect(p.sendOnEnter).toBeDefined()
  })

  it('a pasted image lands in the attachment strip via onUploadFiles', async () => {
    await renderPane()
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'pasted.png', { type: 'image/png' })
    await act(async () => { props().onUploadFiles?.([file]) })
    expect(api.uploadFiles).toHaveBeenCalledWith([file])
    await waitFor(() => expect(props().pendingFiles).toEqual(['/tmp/uploads/pasted.png']))
  })

  it('an @-mention file pick stages the file and a folder pick leaves only its token', async () => {
    await renderPane()
    await act(async () => { props().onFileSelect?.('/repo/src/a.ts', 'file', '@src/a.ts') })
    expect(props().pendingFiles).toEqual(['/repo/src/a.ts'])
    // A dir pick is complete once ChatInput inserted `@rel/`: nothing is staged.
    await act(async () => { props().onFileSelect?.('/repo/src/', 'dir', '@src/') })
    expect(props().pendingFiles).toEqual(['/repo/src/a.ts'])
    // The folder chip derives from the composer text.
    await act(async () => { props().onChange('look at @src/ please') })
    expect(props().pendingDirs).toEqual(['src/'])
    await act(async () => { props().onRemoveDir?.('src/') })
    expect(props().value).toBe('look at please')
  })

  it('removing a picked file chip strips exactly its token from the draft', async () => {
    await renderPane()
    await act(async () => { props().onFileSelect?.('/repo/src/a.ts', 'file', '@src/a.ts') })
    await act(async () => { props().onChange('see @src/a.ts and @src/a.tsx') })
    await act(async () => { props().onRemoveFile?.('/repo/src/a.ts') })
    // Boundary-checked: the longer `@src/a.tsx` token survives.
    expect(props().value).toBe('see and @src/a.tsx')
    expect(props().pendingFiles).toEqual([])
  })
})
