/**
 * Renders the chat DRAFT for a set of element annotations.
 *
 * Model-facing text (hence the `.prompt.ts` boundary): the `eN` refs, roles
 * and selectors are identifiers the agent passes straight back to the
 * `browser` tool, so the draft is English by design. It lands in the
 * composer as editable text -- the user's own notes are quoted verbatim, and
 * the user can add to it before sending.
 *
 * Shape (one line per annotation, numbered like the markers on the attached
 * screenshot):
 *
 *   Annotations on <title> (<url>):
 *   1. [button "Save"] (e12, `form > footer > button.primary`) -- <note>
 */
import { annotationLabel, type AnnotationItem } from './browserAnnotations'

export interface AnnotationDraftMeta {
  url: string
  title: string
  /** Present when a marker screenshot is attached alongside the draft. */
  screenshotName?: string
}

function fmtTarget(a: AnnotationItem): string {
  const kind = a.role || a.tag || 'element'
  const label = annotationLabel(a)
  return label ? `[${kind} "${label}"]` : `[${kind}]`
}

/** One numbered draft line. */
export function formatAnnotationLine(a: AnnotationItem): string {
  const where = a.selector ? `${a.ref}, \`${a.selector}\`` : a.ref
  const gone = a.detached ? ' (element no longer on the page)' : ''
  return `${a.n}. ${fmtTarget(a)} (${where})${gone} -- ${a.note.replace(/\s+/g, ' ').trim()}`
}

/** The whole draft. Items are emitted in display order (`n`). */
export function formatAnnotationDraft(items: readonly AnnotationItem[], meta: AnnotationDraftMeta): string {
  const sorted = [...items].sort((x, y) => x.n - y.n)
  const head = `Annotations on ${meta.title ? `${meta.title} ` : ''}(${meta.url || 'unknown page'}):`
  const lines = [head, ...sorted.map(formatAnnotationLine)]
  const refsNote = 'Refs are the built-in Browser panel\'s element refs (the same `eN` the `browser` tool\'s `snapshot` uses; re-run `snapshot` if the page changed).'
  const shot = meta.screenshotName ? ` The attached \`${meta.screenshotName}\` shows the page with these numbers marked on it.` : ''
  lines.push('', `${refsNote}${shot}`)
  return lines.join('\n')
}
