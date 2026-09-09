import type { ChatMessage } from '../../types'

import { i18nT } from '../../i18n/t'
import type { NoticeTone } from './NoticeCard'

/**
 * Localized copy for the `error` rows the gateway's transient-5xx ladder appends.
 *
 * The gateway writes these rows as plain English text with no i18n of its own,
 * so a zh-CN dashboard showed "⟳ Backend hiccup — retrying…" verbatim, styled as
 * a red failure although the retry was already queued. Each row now also carries
 * a structured wire token in `meta.notice` (`TRANSIENT_NOTICE_*` in
 * `src/kiro_crew/dashboard/chat_utils.py`); the dashboard keys its `i18nT()` copy
 * on that token and never shows the English content. The tokens below are WIRE
 * VALUES, not copy — never translate them, and keep them byte-identical to the
 * Python constants (`test/test_transient_notice_parity.py` pins both sides).
 */
const RETRYING_KEY = 'pages.chat.transientNotice.retrying'
const RESUMING_KEY = 'pages.chat.transientNotice.resuming'
const RESTORED_KEY = 'pages.chat.transientNotice.restored'
const GIVE_UP_KEY = 'pages.chat.transientNotice.give_up'

type Shape = 'retrying' | 'resuming' | 'give_up'

/** `meta.notice` wire tokens → row shape. Mirrors chat_utils.TRANSIENT_NOTICE_*. */
const NOTICE_TOKENS: Readonly<Record<string, Shape>> = {
  transient_retrying: 'retrying',
  transient_resuming: 'resuming',
  transient_give_up: 'give_up',
}

/**
 * Rows persisted BEFORE the token existed carry only the old English text.
 * They are re-read from disk on every reload with no migration, so the frozen
 * legacy spellings are recognised by shape here — a history row renders the
 * same card as a live one. These patterns are closed: the gateway no longer
 * emits this wording, so nothing new can ever match them.
 */
const LEGACY_PENDING_RE = /^⟳ Backend hiccup — (retrying|recovering)…$/u
const LEGACY_GIVE_UP_RE = /^⟳ Backend hiccup — please retry\.$/u

function shapeOf(m: ChatMessage): Shape | null {
  const token = (m.meta as { notice?: unknown } | undefined)?.notice
  if (typeof token === 'string' && token in NOTICE_TOKENS) return NOTICE_TOKENS[token]
  const content = (m.content ?? '').trim()
  const pending = LEGACY_PENDING_RE.exec(content)
  if (pending) return pending[1] === 'retrying' ? 'retrying' : 'resuming'
  if (LEGACY_GIVE_UP_RE.test(content)) return 'give_up'
  return null
}

export interface TransientNotice {
  /** Localized text to render in place of the wire content. */
  text: string
  /**
   * `notice`: the gateway has ALREADY queued the retry, so the row is routine
   * status and renders as a soft NoticeCard. `error`: the ladder gave up (or a
   * nested turn cannot be re-queued) and the person has to act, so it keeps the
   * red ErrorCard.
   */
  card: 'notice' | 'error'
  tone: NoticeTone
}

/** True once a later row proves the model answered again after this notice. */
function answeredAfter(messages: readonly ChatMessage[], index: number): boolean {
  for (let j = index + 1; j < messages.length; j++) {
    const r = messages[j].role
    if (r === 'assistant' || r === 'streaming') return true
  }
  return false
}

/**
 * Resolve an `error` row into localized transient-notice copy, or null when the
 * row is not one of the gateway's transient-5xx notices (a genuine failure keeps
 * its verbatim prose).
 *
 * A pending row ("retrying…") is tense-aware: the gateway never appends a
 * "restored" row when the re-queued turn succeeds, so the notice would read
 * "retrying…" forever in a transcript where the answer already arrived below it.
 * When a later assistant row exists the same card settles to "Connection
 * restored" instead. A later ERROR row does not settle it — the ladder may have
 * given up, and claiming a restore then would be false; the pending copy stays.
 */
export function resolveTransientNotice(
  m: ChatMessage,
  messages: readonly ChatMessage[],
  index: number,
): TransientNotice | null {
  if (m.role !== 'error') return null
  const shape = shapeOf(m)
  if (!shape) return null
  if (shape === 'give_up') {
    return { text: i18nT(GIVE_UP_KEY), card: 'error', tone: 'warn' }
  }
  if (answeredAfter(messages, index)) {
    return { text: i18nT(RESTORED_KEY), card: 'notice', tone: 'info' }
  }
  return {
    text: i18nT(shape === 'resuming' ? RESUMING_KEY : RETRYING_KEY),
    card: 'notice',
    tone: 'warn',
  }
}
