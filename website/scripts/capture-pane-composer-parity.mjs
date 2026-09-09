/**
 * Capture harness for chat-core P3-b (#9775): ChatPane composer parity.
 *
 * Shoots the Crew Members DM composer on two REAL pods — a `main`-based one
 * (before) and this branch's (after) — in light and dark:
 *   crew-dm-composer-{before,after}-{theme}.png   mic button appears
 *   crew-dm-recording-{theme}.png                 dictation in progress
 *   crew-dm-paste-attachment-{theme}.png          pasted image in the strip
 *   crew-dm-mention-menu-{theme}.png              `@` file picker open
 *   crew-dm-voice-setup-{theme}.png               mic click with STT off → modal
 *
 * Usage:
 *   POD_INFO=<after.json> POD_BEFORE=<before.json> node scripts/capture-pane-composer-parity.mjs <outdir>
 *
 * Both JSON files are the last line of `kirocrew pod up <name> --json`.
 *
 * Recording uses Chromium's fake audio device, and `/api/config/stt` is
 * answered `enabled+available` from the harness (the pod's STT provider is not
 * installed) — everything rendered is the real composer reacting to a real
 * MediaRecorder capture. Esc discards the take, so no transcription is posted.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const after = JSON.parse(fs.readFileSync(process.env.POD_INFO, 'utf8').trim().split('\n').pop())
const before = JSON.parse(fs.readFileSync(process.env.POD_BEFORE, 'utf8').trim().split('\n').pop())
const out = path.resolve(process.argv[2] || '.github/screenshots/pane-composer-parity')
fs.mkdirSync(out, { recursive: true })

const VIEW = { width: 1280, height: 800 }
const MEMBER = 'default'
const COMPOSER = 'textarea[aria-label]'
// 1x1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

async function settle(page) {
  await page.waitForURL(u => !String(u).includes('token='), { timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(800)
}

/** The pod token is exchanged for a session on first use, so log in ONCE per
 *  pod and hand every later context the resulting storage state. */
const authState = new Map()
async function login(browser, pod) {
  if (authState.has(pod.base_url)) return authState.get(pod.base_url)
  const ctx = await browser.newContext({ viewport: VIEW })
  const page = await ctx.newPage()
  await page.goto(`${pod.base_url}/?token=${pod.token}`, { waitUntil: 'load' })
  await settle(page)
  const ok = await page.evaluate(async () => (await fetch('/api/status')).status)
  if (ok !== 200) throw new Error(`login to ${pod.base_url} failed: /api/status ${ok}`)
  const state = await ctx.storageState()
  await ctx.close()
  authState.set(pod.base_url, state)
  return state
}

async function session(browser, pod, theme, { stt = false } = {}) {
  const storageState = await login(browser, pod)
  const ctx = await browser.newContext({ viewport: VIEW, permissions: ['microphone'], storageState })
  const page = await ctx.newPage()
  if (stt) {
    await page.route('**/api/config/stt', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ enabled: true, available: true, streaming: false, dictation_panel: true, provider: 'local' }),
    }))
  }
  await page.goto(`${pod.base_url}/`, { waitUntil: 'load' })
  await settle(page)
  const status = await page.evaluate(async (mode) => {
    const r = await fetch('/api/config/theme', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
    return r.status
  }, theme)
  if (status !== 200) throw new Error(`theme PUT ${status}`)
  await page.evaluate((t) => {
    localStorage.setItem('mc-theme', t)
    localStorage.setItem('mc-preview-crew', '1')
  }, theme)
  await page.goto(`${pod.base_url}/members?member=${MEMBER}`, { waitUntil: 'load' })
  await settle(page)
  // A pod running an older build gets the "update available" popup, whose
  // backdrop blurs the whole page. Snooze it (persists in the pod's config).
  const snooze = page.getByRole('button', { name: /Remind me tomorrow/ })
  if (await snooze.isVisible().catch(() => false)) { await snooze.click(); await page.waitForTimeout(500) }
  await page.locator(COMPOSER).first().waitFor({ timeout: 20_000 })
  await page.waitForTimeout(600)
  return { ctx, page }
}

/** The pane's lower region: the ChatPane root (`[data-chat-pane]`) is the
 *  stable frame in every state — recording swaps the textarea for the
 *  dictation panel, so nothing inside the composer is a safe anchor. */
async function composerClip(page, extraTop = 140) {
  const box = await page.locator('[data-chat-pane]').first().boundingBox()
  const height = Math.min(box.height, 200 + extraTop)
  const y = box.y + box.height - height
  return { x: Math.max(0, box.x - 8), y, width: Math.min(VIEW.width - Math.max(0, box.x - 8), box.width + 16), height: Math.min(VIEW.height - y, height + 8) }
}

async function shoot(page, file, clip) {
  await page.screenshot({ path: file, clip })
  console.log(`${path.basename(file)}  ${fs.statSync(file).size} B`)
}

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
try {
  for (const theme of ['light', 'dark']) {
    // BEFORE — main: no mic on the pane composer.
    {
      const { ctx, page } = await session(browser, before, theme)
      await shoot(page, path.join(out, `crew-dm-composer-before-${theme}.png`), await composerClip(page, 40))
      await ctx.close()
    }
    // AFTER — mic present; STT off on this pod → the setup modal on click.
    {
      const { ctx, page } = await session(browser, after, theme)
      await page.getByRole('button', { name: /^(Voice input|Stop recording|Switch to voice)$/ }).first().waitFor({ timeout: 10_000 })
      await shoot(page, path.join(out, `crew-dm-composer-after-${theme}.png`), await composerClip(page, 40))
      await page.getByRole('button', { name: /^(Voice input|Stop recording|Switch to voice)$/ }).first().click()
      await page.getByRole('dialog').waitFor({ timeout: 10_000 })
      await page.waitForTimeout(400)
      await shoot(page, path.join(out, `crew-dm-voice-setup-${theme}.png`))
      await page.keyboard.press('Escape')
      await ctx.close()
    }
    // AFTER with STT on — recording, paste, mention.
    {
      const { ctx, page } = await session(browser, after, theme, { stt: true })
      const mic = page.getByRole('button', { name: /^(Voice input|Stop recording|Switch to voice)$/ }).first()
      await mic.click()
      // The dictation panel / pulsing mic is driven by the real MediaRecorder.
      await page.waitForTimeout(1500)
      await shoot(page, path.join(out, `crew-dm-recording-${theme}.png`), await composerClip(page, 220))
      await page.keyboard.press('Escape') // discard: nothing is transcribed
      await page.waitForTimeout(600)

      // Paste an image: ChatInput.handlePaste → onUploadFiles → the pane uploads
      // and stages it in the attachment strip.
      const ta = page.locator(COMPOSER).first()
      await ta.click()
      await page.evaluate(({ sel, b64 }) => {
        const el = document.querySelector(sel)
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
        const file = new File([bytes], 'pasted.png', { type: 'image/png' })
        const dt = new DataTransfer()
        dt.items.add(file)
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      }, { sel: COMPOSER, b64: PNG_B64 })
      await page.locator('[data-testid="preview-strip"]').waitFor({ timeout: 15_000 })
      await page.waitForTimeout(500)
      await shoot(page, path.join(out, `crew-dm-paste-attachment-${theme}.png`), await composerClip(page, 160))

      // `@` opens the file picker (rendered only when onFileSelect is wired).
      await ta.fill('')
      await ta.type('@sr', { delay: 40 })
      await page.waitForTimeout(900)
      await shoot(page, path.join(out, `crew-dm-mention-menu-${theme}.png`), await composerClip(page, 320))
      await page.keyboard.press('Escape')
      await ctx.close()
    }
  }
} finally {
  await browser.close()
}
