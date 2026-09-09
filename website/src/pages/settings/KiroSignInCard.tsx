import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, LogOut, RefreshCw } from 'lucide-react'
import { api, type KasLoginStatus } from '../../api/client'
import { KasLoginEmbedded, providerLabelFromWire } from '../../components/KasLoginGate'
import ErrorNotice from '../../components/ErrorNotice'
import { Btn, Card, CardTitle } from '../../components/ui'
import { fmtDateTime, fmtRelative } from '../../i18n/format'
import { i18nT } from '../../i18n/t'

/** Registry id of this card (settingsManual.ts), the value a deep link's
 *  `?highlight=` carries. Exported so the chat error row that links here and
 *  the card cannot drift apart on the spelling. */
export const KIRO_SIGN_IN_SETTING_ID = 'overview.kiro-sign-in'
/** The Settings tab the card lives on. */
export const KIRO_SIGN_IN_SETTINGS_TAB = 'overview'

// Same cache key the embedded flow reads status under (KasLoginGate.QUERY_KEY):
// a sign-out here must invalidate the flow's query, not a private copy of it.
const STATUS_QUERY_KEY = ['kas-login'] as const

/**
 * Whether the stored sign-in can still do its job. Two independent verdicts
 * from the gateway, both token-free: `usable` is the spawn-time predicate (an
 * expired access token with nothing to renew it), `refresh_rejected` is the
 * issuer's refusal recorded by the last refresh attempt. Either one means the
 * agents will be told they are not signed in until the user signs in again --
 * and NOTHING falls back to kiro-cli's login on its own, which is why the card
 * has to say so rather than let a live-looking account sit there.
 */
function signInLapsed(status: KasLoginStatus): boolean {
  return !status.usable || status.refresh_rejected
}

function SignedInSummary({
  status,
  onReauth,
}: {
  status: KasLoginStatus
  onReauth: () => void
}) {
  const queryClient = useQueryClient()
  // Set after a successful sign-out until the next status settles, so the
  // "applies to agent processes started from now on" note shows exactly once,
  // at the moment the change was made.
  const [signedOutNote, setSignedOutNote] = useState(false)
  const logout = useMutation({
    mutationFn: () => api.kasLoginLogout(status.identity ?? ''),
    onSuccess: () => {
      setSignedOutNote(true)
      void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY })
    },
  })
  const lapsed = signInLapsed(status)
  const provider = providerLabelFromWire(status.provider)
  // What renews the session, in words the user can act on: an access token the
  // engine refreshes itself, one that has already lapsed, or one the issuer
  // refused to renew. Never the token, never its length.
  const expiryLine = status.refresh_rejected
    ? i18nT('pages.settings.kiroSignInCard.refresh_rejected')
    : status.expired
      ? status.has_refresh_token
        ? i18nT('pages.settings.kiroSignInCard.expired_renews_on_next_use')
        : i18nT('pages.settings.kiroSignInCard.expired_no_refresh')
      : status.expires_at
        ? i18nT('pages.settings.kiroSignInCard.access_token_expires', {
            when: fmtRelative(status.expires_at),
            at: fmtDateTime(status.expires_at),
          })
        : ''
  return (
    <div data-testid="kiro-sign-in-summary" data-lapsed={lapsed ? 'true' : 'false'}>
      <div className="flex flex-wrap items-start gap-3">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            lapsed ? 'bg-warn/15 text-warn' : 'bg-ok/15 text-ok'
          }`}
          aria-hidden="true"
        >
          {lapsed ? <AlertTriangle className="lucide-inline" /> : <CheckCircle2 className="lucide-inline" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-strong" data-testid="kiro-sign-in-state">
            {lapsed
              ? i18nT('pages.settings.kiroSignInCard.sign_in_expired')
              : i18nT('pages.settings.kiroSignInCard.signed_in_with', { provider })}
          </p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
            {lapsed
              ? i18nT('pages.settings.kiroSignInCard.sign_in_expired_body', { provider })
              : i18nT('pages.settings.kiroSignInCard.signed_in_body')}
          </p>
          {expiryLine ? (
            <p className="mt-1 text-[12px] text-muted" data-testid="kiro-sign-in-expiry">
              {expiryLine}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {lapsed ? (
          <Btn type="button" primary onClick={onReauth} disabled={logout.isPending}>
            <RefreshCw className="lucide-inline" aria-hidden="true" />
            {i18nT('pages.settings.kiroSignInCard.sign_in_again')}
          </Btn>
        ) : (
          <Btn type="button" onClick={onReauth} disabled={logout.isPending}>
            <RefreshCw className="lucide-inline" aria-hidden="true" />
            {i18nT('pages.settings.kiroSignInCard.switch_account')}
          </Btn>
        )}
        <Btn
          type="button"
          danger
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
          data-testid="kiro-sign-in-logout"
        >
          {logout.isPending ? (
            <Loader2 className="lucide-inline animate-spin" aria-hidden="true" />
          ) : (
            <LogOut className="lucide-inline" aria-hidden="true" />
          )}
          {i18nT('pages.settings.kiroSignInCard.sign_out')}
        </Btn>
      </div>
      {signedOutNote ? (
        <p className="mt-3 text-[12px] text-muted" role="status" data-testid="kiro-sign-in-takes-effect">
          {i18nT('pages.settings.kiroSignInCard.takes_effect_next_process')}
        </p>
      ) : null}
      {/* askAgent off: the failure is about the credential store the agent
          itself runs on; the message names the remedy (retry / doctor). */}
      <ErrorNotice
        className="mt-3"
        title={i18nT('pages.settings.kiroSignInCard.could_not_sign_out')}
        message={logout.error?.message || null}
        testId="kiro-sign-in-logout-error"
      />
    </div>
  )
}

/**
 * Settings card for signing in to Kiro Crew's OWN Kiro identity -- the one the
 * gateway hands to agent processes (KAS relay) so they run as the user without
 * depending on `kiro-cli login`. Wraps the sign-in flow `KasLoginGate` carries
 * in its embedded chrome, and adds the two things a card needs that a gate does
 * not: a signed-in summary (provider, expiry, renewability -- never a token)
 * with sign-out, and an explicit "sign-in expired" state that asks the user to
 * sign in again instead of quietly falling back to kiro-cli's login.
 *
 * The `data-setting-label` on the wrapper is the deep-link anchor
 * (useSettingHighlight), matched against the manual registry entry
 * `overview.kiro-sign-in` in settingsManual.ts.
 */
export function KiroSignInCard() {
  const title = i18nT('pages.settings.kiroSignInCard.title')
  return (
    <Card data-setting-label={title} data-testid="kiro-sign-in-card">
      <CardTitle>
        <KeyRound className="lucide-inline" aria-hidden="true" />
        {title}
      </CardTitle>
      <KasLoginEmbedded
        renderPending={() => (
          <p className="flex items-center gap-2 text-[13px] text-muted" data-testid="kiro-sign-in-pending">
            <Loader2 className="lucide-inline animate-spin" aria-hidden="true" />
            {i18nT('pages.settings.kiroSignInCard.checking')}
          </p>
        )}
        renderAuthenticated={(status, { reauth }) => (
          <SignedInSummary status={status} onReauth={reauth} />
        )}
        renderReauthCancel={(cancel) => (
          <button
            type="button"
            onClick={cancel}
            className="mt-3 cursor-pointer text-[13px] text-muted underline-offset-2 hover:text-text hover:underline focus-ring"
            data-testid="kiro-sign-in-keep-current"
          >
            {i18nT('pages.settings.kiroSignInCard.keep_current_sign_in')}
          </button>
        )}
      />
    </Card>
  )
}
