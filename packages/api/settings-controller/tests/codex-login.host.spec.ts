import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexLoginController } from '../src/codex-login.ts'
import type { CodexLoginView } from '../src/types.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

const key = credentialKey('llm-pi-ai', 'openai-codex')
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function nextView(iterator: AsyncIterator<CodexLoginView>): Promise<CodexLoginView> {
  const next = await iterator.next()
  if (next.done) throw new Error('login stream ended before the expected view')
  return next.value
}

async function boot(run?: (session: AuthorizationSession) => Promise<void>): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(CodexLoginController)
  if (run !== undefined) ctx.authorization.registerFlow({ key, label: 'Codex', methods: [{ id: 'oauth', label: 'ChatGPT' }], run })
  return ctx
}

describe('ChatGPT login transport', () => {
  it('reports absent OAuth without exposing credentials', async () => {
    const ctx = await boot()
    expect(await ctx.codexLoginController.describe()).toEqual({ available: false, configured: false, writable: true, inFlight: false })
    await expect(ctx.codexLoginController.signIn(new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow('unavailable')
  })

  it('delivers method choices, device codes and verified persistence without token payloads', async () => {
    let finish: (() => void) | undefined
    const ctx = await boot(async (session) => {
      const method = await session.prompt({ kind: 'select', message: 'Choose', options: [{ id: 'device_code', label: 'Device' }], signal: session.signal })
      expect(method).toBe('device_code')
      session.notify({ message: 'Authorize', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH' })
      await new Promise<void>((resolve) => { finish = resolve })
      await session.commit({ kind: 'grant', payload: { access: 'secret-access', refresh: 'secret-refresh' } })
    })
    const stream = ctx.codexLoginController.signIn(new AbortController().signal)[Symbol.asyncIterator]()
    const initial = (await nextView(stream))
    expect(initial.prompt?.kind).toBe('select')
    expect(await ctx.codexLoginController.describe()).toMatchObject({ inFlight: true })
    expect(() =>{  ctx.codexLoginController.respond(initial.id, initial.revision + 1, 'device_code') }).toThrow('expired')
    expect(() =>{  ctx.codexLoginController.respond(initial.id, initial.revision, 'bad') }).toThrow('invalid')
    ctx.codexLoginController.respond(initial.id, initial.revision, 'device_code')
    const device = (await nextView(stream))
    expect(device.notice?.code).toBe('ABCD-EFGH')
    expect(device.prompt).toBeUndefined()
    finish?.()
    const terminal = (await nextView(stream))
    expect(terminal.status).toBe('authorized')
    expect(JSON.stringify([device, terminal, await ctx.codexLoginController.describe()])).not.toContain('secret-')
    expect((await stream.next()).done).toBe(true)
    expect(await ctx.codexLoginController.describe()).toMatchObject({ configured: true, inFlight: false })
    expect(() =>{  ctx.codexLoginController.respond(initial.id, initial.revision, 'device_code') }).toThrow('expired')
  })

  it('keeps the browser link when a manual callback prompt follows it', async () => {
    const ctx = await boot(async (session) => {
      session.notify({ message: 'Open browser', url: 'https://auth.openai.com/oauth/authorize?state=fixture' })
      const callback = await session.prompt({ kind: 'text', message: 'Paste callback', signal: session.signal })
      expect(callback).toBe('http://localhost:1455/auth/callback?code=fixture')
      await session.commit({ kind: 'grant', payload: {} })
    })
    const stream = ctx.codexLoginController.signIn(new AbortController().signal)[Symbol.asyncIterator]()
    const question = (await nextView(stream))
    expect(question.notice?.url).toContain('/oauth/authorize')
    ctx.codexLoginController.respond(question.id, question.revision, 'http://localhost:1455/auth/callback?code=fixture')
    expect((await nextView(stream)).status).toBe('authorized')
    await stream.next()
  })

  it('redacts failure bodies and allows a new attempt after cancellation', async () => {
    let fail = false
    const ctx = await boot(async (session) => {
      if (fail) throw new Error('access_token=secret-leak')
      await session.prompt({ kind: 'secret', message: 'Confirm', signal: session.signal })
    })
    const abort = new AbortController()
    const stream = ctx.codexLoginController.signIn(abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    await expect(ctx.codexLoginController.signOut()).rejects.toThrow('active')
    await expect(ctx.codexLoginController.signIn(new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow('running')
    abort.abort()
    expect((await stream.next()).done).toBe(true)
    expect(await ctx.codexLoginController.describe()).toMatchObject({ inFlight: false })
    fail = true
    const next = ctx.codexLoginController.signIn(new AbortController().signal)[Symbol.asyncIterator]()
    const first = await nextView(next)
    const terminal = first.status === 'failed' ? first : await nextView(next)
    expect(terminal.status).toBe('failed')
    expect(JSON.stringify(terminal)).not.toContain('secret-leak')
    await next.next()
  })

  it('signs out only its grant and refuses to delete a different record kind', async () => {
    const ctx = await boot()
    const other = credentialKey('llm-pi-ai', 'other')
    await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { refresh: 'fixture' } }))
    await ctx.credentials.modifyRecord(other, async () => ({ kind: 'grant', payload: {} }))
    await ctx.codexLoginController.signOut()
    expect(await ctx.credentials.readRecord(key)).toBeUndefined()
    expect(await ctx.credentials.readRecord(other)).toBeDefined()
    await ctx.credentials.modifyRecord(key, async () => ({ kind: 'api-key', key: 'fixture' }))
    await expect(ctx.codexLoginController.signOut()).rejects.toThrow('Could not remove')
    expect(await ctx.credentials.readRecord(key)).toBeDefined()
  })

  it('withdraws active prompts on owner disposal', async () => {
    let withdrawn = false
    const ctx = await boot(async (session) => {
      try { await session.prompt({ kind: 'text', message: 'Waiting' }) }
      catch (error) { withdrawn = true; throw error }
    })
    const stream = ctx.codexLoginController.signIn(new AbortController().signal)[Symbol.asyncIterator]()
    await stream.next()
    await ctx.fiber.dispose()
    expect(withdrawn).toBe(true)
    expect((await nextView(stream)).status).toBe('cancelled')
    expect((await stream.next()).done).toBe(true)
  })
})
