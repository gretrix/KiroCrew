import { describe, expect, it } from 'vitest'
import {
  LABEL_MAX,
  annotationLabel,
  annotationScreenshotFile,
  describeAnnotationTarget,
  truncate,
  type AnnotationItem,
} from '../utils/browserAnnotations'
import { formatAnnotationDraft, formatAnnotationLine } from '../utils/browserAnnotations.prompt'

const item = (over: Partial<AnnotationItem> = {}): AnnotationItem => ({
  id: 1, n: 1, note: 'too far right', ref: 'e12', tag: 'button', role: 'button', name: 'Save', text: 'Save',
  selector: 'form > footer > button.primary', rect: { x: 1, y: 2, width: 3, height: 4 }, detached: false, ...over,
})

describe('describeAnnotationTarget / labels', () => {
  it('prefers the accessible name, falls back to visible text, truncates to LABEL_MAX', () => {
    expect(annotationLabel({ name: 'Save', text: 'Save changes now' })).toBe('Save')
    expect(annotationLabel({ name: '', text: '  Some   paragraph\n text ' })).toBe('Some paragraph text')
    const long = 'x'.repeat(LABEL_MAX + 10)
    expect(annotationLabel({ name: long, text: '' })).toHaveLength(LABEL_MAX)
    expect(annotationLabel({ name: long, text: '' }).endsWith('…')).toBe(true)
    expect(truncate('short')).toBe('short')
  })

  it('renders tag + quoted label, or the bare tag when the element has no words', () => {
    expect(describeAnnotationTarget({ tag: 'button', name: 'Save', text: 'Save' })).toBe('button "Save"')
    expect(describeAnnotationTarget({ tag: 'p', name: '', text: 'Some paragraph text here.' })).toBe('p "Some paragraph text here."')
    expect(describeAnnotationTarget({ tag: 'div', name: '', text: '' })).toBe('div')
  })
})

describe('annotationScreenshotFile', () => {
  it('decodes base64 into a PNG File named with the stamp', async () => {
    const f = annotationScreenshotFile(btoa('png-bytes'), '2026-01-02T03-04-05')
    expect(f.name).toBe('browser-annotations-2026-01-02T03-04-05.png')
    expect(f.type).toBe('image/png')
    expect(await f.text()).toBe('png-bytes')
  })
})

describe('annotation draft', () => {
  it('formats one line as N. [role "label"] (ref, `selector`) -- note', () => {
    expect(formatAnnotationLine(item())).toBe('1. [button "Save"] (e12, `form > footer > button.primary`) -- too far right')
  })

  it('falls back to the tag when there is no role, omits the selector when unknown, flags detached elements', () => {
    expect(formatAnnotationLine(item({ n: 2, role: '', tag: 'p', name: '', text: 'Body copy', selector: '', note: ' fix   typo ' })))
      .toBe('2. [p "Body copy"] (e12) -- fix typo')
    expect(formatAnnotationLine(item({ detached: true }))).toContain('(element no longer on the page)')
    expect(formatAnnotationLine(item({ name: '', text: '' }))).toContain('[button] (')
  })

  it('emits a header with title and url, lines in display order, and the refs/screenshot note', () => {
    const draft = formatAnnotationDraft(
      [item({ n: 2, id: 7, ref: 'e4', tag: 'input', role: 'textbox', name: 'Search', note: 'change the placeholder' }), item()],
      { url: 'https://x.test/p', title: 'Settings', screenshotName: 'browser-annotations-1.png' },
    )
    const lines = draft.split('\n')
    expect(lines[0]).toBe('Annotations on Settings (https://x.test/p):')
    expect(lines[1]).toMatch(/^1\. \[button "Save"\]/)
    expect(lines[2]).toMatch(/^2\. \[textbox "Search"\] \(e4,/)
    expect(draft).toContain('`snapshot`')
    expect(draft).toContain('The attached `browser-annotations-1.png` shows the page with these numbers marked on it.')
  })

  it('copes with no title, no url and no screenshot', () => {
    const draft = formatAnnotationDraft([item()], { url: '', title: '' })
    expect(draft.startsWith('Annotations on (unknown page):')).toBe(true)
    expect(draft).not.toContain('The attached')
  })
})
