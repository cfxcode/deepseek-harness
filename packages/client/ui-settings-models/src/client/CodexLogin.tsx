/** Subscription login controls; all wire interaction belongs to the page store. */
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodexLoginInfo, CodexLoginView } from '@deepseek-ai/dsh-api-remotes/client'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Data and commands passed by the Models owner; no credential values are rendered. */
interface CodexLoginProps {
  info: CodexLoginInfo | undefined
  view: CodexLoginView | undefined
  busy: boolean
  signingIn: boolean
  failed: boolean
  keyOverride: boolean
  t: (key: keyof typeof en) => string
  onStart: () => void
  onAnswer: (value: string) => Promise<void>
  onClose: () => void
  onSignOut: () => Promise<void>
}

/**
 * Present safe subscription-login state and a cancellable dialog.
 * @param props - safe login state and owner callbacks.
 * @returns the login controls and dialog.
 */
export function CodexLogin(props: CodexLoginProps): ReactNode {
  const { info, view, busy, signingIn, failed, keyOverride, t, onStart, onAnswer, onClose, onSignOut } = props
  const [answer, setAnswer] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputId = useId()
  const close = (): void => { setAnswer(''); onClose() }
  const start = (): void => { setAnswer(''); onStart() }
  const prompt = view?.prompt
  const submit = (value: string): void => {
    if (submitting) return
    setAnswer('')
    setSubmitting(true)
    void onAnswer(value).finally(() => { setSubmitting(false) })
  }
  const options = prompt?.options?.toSorted((left, right) =>
    (left.id === 'device_code' ? 0 : 1) - (right.id === 'device_code' ? 0 : 1))
  const label = (id: string, fallback: string): string =>
    id === 'device_code' ? t('codexDevice') : id === 'browser' ? t('codexBrowser') : fallback
  const notice = view?.notice
  let url: string | undefined
  if (notice?.url !== undefined) {
    try {
      const parsed = new URL(notice.url)
      if (parsed.protocol === 'https:') url = parsed.href
    } catch { /* Malformed links are never turned into navigation targets. */ }
  }
  const open = view !== undefined || signingIn
  return (
    <div className={styles['codexLogin']}>
      <div className={styles['rowHead']}>
        <span>{t(info?.configured ? 'codexConnected' : 'codexDisconnected')}</span>
        <span className={styles['rowActions']}>
          <Button variant="outline" disabled={busy || !info?.available || !info.writable || info.inFlight} onClick={start}>
            {t(info?.configured ? 'codexReconnect' : 'codexSignIn')}
          </Button>
          {info?.configured
            ? <Button variant="outline" disabled={busy || !info.writable || info.inFlight} onClick={() => { void onSignOut() }}>{t('codexSignOut')}</Button>
            : null}
        </span>
      </div>
      {!info?.available ? <p className={styles['advancedHint']}>{t('codexUnavailable')}</p> : null}
      {keyOverride ? <p className={styles['advancedHint']}>{t('codexKeyOverride')}</p> : null}
      {failed && !open ? <p role="alert" className={styles['error']}>{t('codexFailed')}</p> : null}
      <Modal open={open} onClose={close} title={t('codexSignIn')} closeLabel={t('close')}
        description={t('codexDescription')}
        footer={<Button variant="outline" onClick={close}>{t(busy ? 'cancel' : 'close')}</Button>}
      >
        <div className={styles['codexContent']}>
          {view?.status === 'authorized' ? <p role="status">{t('codexSuccess')}</p> : null}
          {view?.status === 'cancelled' ? <p role="status">{t('codexCancelled')}</p> : null}
          {view?.status === 'failed' || failed ? <p role="alert" className={styles['error']}>{t('codexFailed')}</p> : null}
          {view?.status === 'running' && prompt === undefined
            ? <p role="status">{notice?.message ?? t('codexWaiting')}</p> : null}
          {notice?.code !== undefined ? <code className={styles['codexCode']}>{notice.code}</code> : null}
          {url !== undefined ? <a href={url} target="_blank" rel="noopener noreferrer">{t('codexOpenPage')}</a> : null}
          {prompt?.kind === 'select' ? <>
            <p>{t('codexChooseMethod')}</p>
            <div className={styles['rowActions']}>
              {options?.map(option => <Button key={option.id} variant="outline" disabled={submitting}
                onClick={() => { submit(option.id) }}>{label(option.id, option.label)}</Button>)}
            </div>
            <p className={styles['advancedHint']}>{t('codexDeviceHint')}</p>
          </> : prompt !== undefined ? <form onSubmit={(event) => { event.preventDefault(); submit(answer) }}>
            <label htmlFor={inputId}>{prompt.message}</label>
            <input id={inputId} className={styles['input']} type={prompt.kind === 'secret' ? 'password' : 'text'}
              value={answer} autoComplete="off" placeholder={prompt.placeholder}
              disabled={submitting} onChange={(event) => { setAnswer(event.target.value) }} />
            <Button type="submit" variant="outline" disabled={submitting || answer.trim().length === 0}>{t('codexContinue')}</Button>
          </form> : null}
          {view?.status === 'failed' || failed ? <Button variant="outline" disabled={busy} onClick={start}>{t('retry')}</Button> : null}
        </div>
      </Modal>
    </div>
  )
}
