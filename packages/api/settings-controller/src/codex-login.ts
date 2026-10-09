/** ChatGPT subscription login transport; the registered pi-ai flow owns OAuth and persistence. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-authorization'
import type { AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CodexLoginAttemptId, CodexLoginInfo, CodexLoginView } from './types.ts'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')

interface Attempt {
  controller: AbortController
  done: Promise<void>
  answer?: { revision: number; prompt: AuthorizationPrompt; resolve: (answer: string) => void }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Settings-owned ChatGPT subscription login transport. */
    codexLoginController: CodexLoginController
  }
}

/** Interactive login for the exact record consumed by the built-in openai-codex provider. */
export class CodexLoginController extends TypertRemoteService {
  private readonly attempts = new Map<CodexLoginAttemptId, Attempt>()
  private signingOut = false

  /**
   * Mount the namespace without requiring an OAuth-capable composition.
   * @param ctx - host context; disposal withdraws and settles owned attempts.
   */
  constructor(ctx: Context) {
    super(ctx, 'codexLoginController', { namespace: 'codexLogin' })
    ctx.effect(() => async () => {
      const attempts = [...this.attempts.values()]
      for (const attempt of attempts) attempt.controller.abort()
      await Promise.all(attempts.map(attempt => attempt.done))
    }, 'codex login attempts')
  }

  /**
   * Describe login capability and stored-grant metadata without reading token values.
   * @returns availability, record presence and writability.
   */
  @Remote
  async describe(): Promise<CodexLoginInfo> {
    const entry = this.ctx.get('authorization')?.describe(KEY)
    let record
    try { record = await this.ctx.get('credentials')?.describeRecord(KEY) }
    catch { throw new RemoteError('gateway/internal', 'Could not read ChatGPT login state', {}) }
    return {
      available: entry?.methods.some(method => method.id === 'oauth') === true,
      configured: record?.configured === true && record.kind === 'grant',
      writable: record?.writable === true,
      inFlight: entry?.inFlight === true || this.signingOut,
    }
  }

  /**
   * Run OAuth and deliver prompts only to the initiating caller.
   * @param signal - disconnect or caller cancellation withdraws the attempt.
   * @returns coalesced progress, prompt and terminal views, never credential payloads.
   * @throws RemoteError when OAuth is unavailable, read-only or already running.
   */
  @Remote({ mode: 'stream' })
  async *signIn(signal: AbortSignal): AsyncIterable<CodexLoginView> {
    const info = await this.describe()
    if (!info.available || !info.writable || info.inFlight) {
      throw new RemoteError('gateway/bad-request', 'ChatGPT login is unavailable or already running', {})
    }
    signal.throwIfAborted()
    const authorization = this.ctx.get('authorization')
    if (authorization === undefined) throw new RemoteError('gateway/bad-request', 'ChatGPT login is unavailable', {})
    const id = brandString<CodexLoginAttemptId>(randomUUID())
    const controller = new AbortController()
    const withdraw = (): void => { controller.abort() }
    signal.addEventListener('abort', withdraw, { once: true })
    let revision = 0
    let view: CodexLoginView = { id, status: 'running', revision }
    let pending = true
    let ended = false
    const hasEnded = (): boolean => ended
    let wake: (() => void) | undefined
    const publish = (next: CodexLoginView): void => { view = next; pending = true; wake?.(); wake = undefined }
    const attempt: Attempt = { controller, done: Promise.resolve() }
    this.attempts.set(id, attempt)
    attempt.done = authorization.begin({
      key: KEY, method: 'oauth', signal: controller.signal,
      interaction: {
        notify: (notice) => {
          const { prompt, ...previous } = view
          publish({ ...previous, ...attempt.answer === undefined ? {} : { prompt }, id, status: 'running', revision, notice: {
            message: notice.message,
            ...notice.url === undefined ? {} : { url: notice.url },
            ...notice.code === undefined ? {} : { code: notice.code },
          } })
        },
        prompt: prompt => new Promise<string>((resolve, reject) => {
          const promptSignal = prompt.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, prompt.signal])
          const abort = (): void => { cleanup(); reject(new Error('login prompt withdrawn')) }
          const cleanup = (): void => {
            promptSignal.removeEventListener('abort', abort)
            if (attempt.answer?.revision === current) delete attempt.answer
          }
          const current = ++revision
          if (promptSignal.aborted) { reject(new Error('login prompt withdrawn')); return }
          attempt.answer = { revision: current, prompt, resolve: (answer) => { cleanup(); resolve(answer) } }
          promptSignal.addEventListener('abort', abort, { once: true })
          publish({ ...view, id, status: 'running', revision: current, prompt: {
            kind: prompt.kind, message: prompt.message,
            ...prompt.kind === 'select'
              ? { options: prompt.options.map(option => ({ id: option.id, label: option.label })) }
              : prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
          } })
        }),
      },
    }).then((outcome) => {
      publish({ id, status: outcome.status, revision })
    }, () => {
      // Provider failures can include HTTP response bodies or tokens. They must
      // not cross the transport or become a persistent browser diagnostic.
      publish({ id, status: 'failed', revision })
    }).finally(() => { ended = true; wake?.(); wake = undefined })
    try {
      while (!signal.aborted) {
        if (pending) { pending = false; yield view }
        else if (hasEnded()) break
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      controller.abort()
      signal.removeEventListener('abort', withdraw)
      await attempt.done
      this.attempts.delete(id)
    }
  }

  /**
   * Answer only the current question of an owned attempt; stale answers are rejected.
   * @param id - opaque identifier delivered by signIn.
   * @param revision - question revision delivered with the prompt.
   * @param value - selected option id or typed answer; not retained after submission.
   * @returns once the answer is delivered to the OAuth flow.
   * @throws RemoteError for expired attempts or invalid answers.
   */
  @Remote
  respond(id: CodexLoginAttemptId, revision: number, value: string): void {
    const attempt = this.attempts.get(id)
    const answer = attempt?.answer
    if (answer === undefined || answer.revision !== revision || attempt?.controller.signal.aborted
      || typeof value !== 'string' || value.length === 0 || value.length > 8192
      || (answer.prompt.kind === 'select' && !answer.prompt.options.some(option => option.id === value))) {
      throw new RemoteError('gateway/bad-request', 'ChatGPT login question has expired or the answer is invalid', {})
    }
    answer.resolve(value)
  }

  /**
   * Forget this provider's grant; other credentials and provider settings are kept.
   * @returns once the stored grant has been removed.
   * @throws RemoteError when login is active, storage is absent or deletion fails.
   */
  @Remote
  async signOut(): Promise<void> {
    const credentials = this.ctx.get('credentials')
    if (!credentials || this.signingOut || this.ctx.get('authorization')?.describe(KEY)?.inFlight) {
      throw new RemoteError('gateway/bad-request', 'ChatGPT login is active or credential storage is unavailable', {})
    }
    this.signingOut = true
    try {
      const info = await credentials.describeRecord(KEY)
      if (info.configured && info.kind !== 'grant') throw new Error('record is not an OAuth grant')
      await credentials.deleteRecord(KEY)
    } catch {
      throw new RemoteError('gateway/internal', 'Could not remove ChatGPT login', {})
    } finally { this.signingOut = false }
  }
}
