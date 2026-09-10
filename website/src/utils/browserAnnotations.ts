/**
 * Browser-panel element annotations: the renderer-side pure pieces.
 *
 * The overlay that highlights, picks and edits lives in the page (see
 * electron/browser-annotate.js); the panel only mirrors its state. This module
 * holds what the panel needs that is DOM-free and testable: the short element
 * description shown in the list, the file the chat receives, and the window
 * event that hands both to ChatPage. The agent-facing draft text lives in
 * `browserAnnotations.prompt.ts`.
 */

/** Window event: the panel hands a finished annotation set to ChatPage --
 *  `{ slot, files, draft }`. ChatPage uploads the files into the composer's
 *  attachments and puts `draft` into the composer text (NOT sent), so the
 *  user can add a sentence before sending. */
export const PREVIEW_ANNOTATE_EVENT = 'kirocrew-web-preview-annotate'

export interface PreviewAnnotateDetail {
  slot: string
  files: File[]
  draft: string
}

/** Mirrors BrowserAnnotation (electron-bridge.d.ts) structurally so tests and
 *  the prompt module need no ambient types. */
export interface AnnotationItem {
  id: number
  n: number
  note: string
  ref: string
  tag: string
  role: string
  name: string
  text: string
  selector: string
  rect: { x: number; y: number; width: number; height: number }
  detached: boolean
}

/** Cap for the element label shown in the list and the draft. */
export const LABEL_MAX = 40

export function truncate(s: string, max: number = LABEL_MAX): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** The element's human label: accessible name first, visible text second. */
export function annotationLabel(a: Pick<AnnotationItem, 'name' | 'text'>): string {
  return truncate(a.name || a.text || '')
}

/** Short identification for the list: `button "Save"`, `p "Some paragraph…"`.
 *  Tag first because that is what a person sees in devtools; the label makes
 *  two same-tag rows tell apart. */
export function describeAnnotationTarget(a: Pick<AnnotationItem, 'tag' | 'name' | 'text'>): string {
  const label = annotationLabel(a)
  return label ? `${a.tag} "${label}"` : a.tag
}

/** Local-time stamp for the screenshot file name (mirrors the sketch pad's
 *  `sketch-<ts>` naming so annotation files sort next to it). */
export function annotationStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/** Decode a base64 PNG into a File for the upload pipeline. */
export function annotationScreenshotFile(pngBase64: string, stamp: string = annotationStamp()): File {
  const bin = atob(pngBase64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], `browser-annotations-${stamp}.png`, { type: 'image/png' })
}
