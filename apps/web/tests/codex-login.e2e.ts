/** Real Web composition and pi-ai OAuth, with only OpenAI's external HTTP responses replaced. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-authorization'
import {
  acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOTS = fileURLToPath(new URL('./expected/codex-login', import.meta.url))
const KEY = credentialKey('llm-pi-ai', 'openai-codex')
const OTHER = credentialKey('codex-login-test', 'kept')
const ACCESS = `fixture.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' },
})).toString('base64')}.signature`

describe('Models settings: ChatGPT subscription login', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleWatch: ReturnType<typeof watchConsole>
  let release: (() => void) | undefined
  let cancelledPolls = 0
  let tokenFailure = false
  let restoreFetch: (() => void) | undefined

  beforeAll(async () => {
    const original = globalThis.fetch
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== 'https://auth.openai.com') return original(input, init)
      if (url.pathname === '/api/accounts/deviceauth/usercode') {
        return Response.json({ device_auth_id: 'fixture-device', user_code: 'ABCD-EFGH', interval: 0 })
      }
      if (url.pathname === '/api/accounts/deviceauth/token') {
        await new Promise<void>((resolve, reject) => {
          const signal = init?.signal
          const abort = (): void => { cancelledPolls++; release = undefined; reject(new Error('fixture request aborted')) }
          if (signal?.aborted) { abort(); return }
          signal?.addEventListener('abort', abort, { once: true })
          release = () => { signal?.removeEventListener('abort', abort); release = undefined; resolve() }
        })
        return Response.json({ authorization_code: 'fixture-code', code_verifier: 'fixture-verifier' })
      }
      if (url.pathname === '/oauth/token') {
        return tokenFailure
          ? new Response('access_token=secret-fixture-error', { status: 403 })
          : Response.json({ access_token: ACCESS, refresh_token: 'secret-fixture-refresh', expires_in: 3600 })
      }
      throw new Error(`Unexpected OpenAI auth request: ${url.pathname}`)
    })
    restoreFetch = () => { mock.mockRestore() }
    scaffold = await launchWebScaffold({})
    await scaffold.ctx.credentials.modifyRecord(OTHER, async () => ({ kind: 'grant', payload: {} }))
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    page.setDefaultTimeout(10_000)
    consoleWatch = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '模型', exact: true }).click()
    await settings.getByRole('button', { name: '添加模型提供商' }).click()
    await settings.getByLabel('提供商', { exact: true }).selectOption('openai-codex')
    await settings.getByText('使用 ChatGPT 订阅时，API 密钥可以留空。保存提供商后，点击“登录 ChatGPT”').waitFor()
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await settings.getByRole('button', { name: '登录 ChatGPT', exact: true }).waitFor()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    restoreFetch?.()
  })

  async function snapshot(name: string): Promise<void> {
    await compareOrRefreshGolden(join(SNAPSHOTS, `${name}.expected.md`),
      await captureStableAria(page, name === 'connected' ? '[role="dialog"]' : '[role="dialog"][aria-label="登录 ChatGPT"]',
        scaffold.workspaceCwd), webSnapshotMode())
  }

  async function chooseDevice(): Promise<void> {
    const login = page.getByRole('dialog', { name: '登录 ChatGPT', exact: true })
    await login.getByRole('button', { name: '设备码登录', exact: true }).click()
    await login.getByText('ABCD-EFGH', { exact: true }).waitFor()
    await expect.poll(() => release !== undefined).toBe(true)
    expect(await login.getByRole('link', { name: '打开授权页面' }).getAttribute('href'))
      .toBe('https://auth.openai.com/codex/device')
  }

  it('offers both methods and cancels a device request without writing a grant', async () => {
    await page.getByRole('button', { name: '登录 ChatGPT', exact: true }).click()
    await page.getByRole('button', { name: '设备码登录', exact: true }).waitFor()
    await snapshot('methods')
    await chooseDevice()
    await snapshot('device')
    await page.getByRole('dialog', { name: '登录 ChatGPT', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
    await expect.poll(() => cancelledPolls).toBe(1)
    await expect.poll(() => scaffold.ctx.authorization.describe(KEY)?.inFlight).toBe(false)
    expect(await scaffold.ctx.credentials.readRecord(KEY)).toBeUndefined()
  })

  it('persists the real OAuth grant, refreshes the page and removes only that grant on logout', async () => {
    const start = page.getByRole('button', { name: '登录 ChatGPT', exact: true })
    await expect.poll(() => start.isEnabled()).toBe(true)
    await start.click()
    await chooseDevice()
    release?.()
    const login = page.getByRole('dialog', { name: '登录 ChatGPT', exact: true })
    await login.getByText('已保存 ChatGPT 登录凭据，可以使用 openai-codex 了').waitFor()
    await login.getByRole('button', { name: '关闭', exact: true }).last().click()
    await page.getByText('已连接 ChatGPT 账号', { exact: true }).waitFor()
    await snapshot('connected')
    expect(await scaffold.ctx.credentials.readRecord(KEY)).toMatchObject({
      kind: 'grant', payload: { access: ACCESS, refresh: 'secret-fixture-refresh', accountId: 'fixture-account' },
    })
    expect(await page.content()).not.toContain('secret-fixture-refresh')
    const warningsBeforeReload = consoleWatch.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(consoleWatch, warningsBeforeReload)
    await openSettings(page, 'zh')
    await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '模型', exact: true }).click()
    await page.getByText('已连接 ChatGPT 账号', { exact: true }).waitFor()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByText('未连接 ChatGPT 账号', { exact: true }).waitFor()
    expect(await scaffold.ctx.credentials.readRecord(KEY)).toBeUndefined()
    expect(await scaffold.ctx.credentials.readRecord(OTHER)).toBeDefined()
  })

  it('keeps the browser authorization link beside the manual callback prompt', async () => {
    const start = page.getByRole('button', { name: '登录 ChatGPT', exact: true })
    await expect.poll(() => start.isEnabled()).toBe(true)
    await start.click()
    await page.getByRole('button', { name: '浏览器登录', exact: true }).click()
    const login = page.getByRole('dialog', { name: '登录 ChatGPT', exact: true })
    const link = login.getByRole('link', { name: '打开授权页面' })
    await link.waitFor()
    expect(new URL((await link.getAttribute('href'))!).origin).toBe('https://auth.openai.com')
    await login.getByRole('textbox').waitFor()
    await login.getByRole('button', { name: '取消', exact: true }).click()
    await expect.poll(() => scaffold.ctx.authorization.describe(KEY)?.inFlight).toBe(false)
  })

  it('shows a retryable failure without leaking OpenAI response bodies', async () => {
    tokenFailure = true
    const start = page.getByRole('button', { name: '登录 ChatGPT', exact: true })
    await expect.poll(() => start.isEnabled()).toBe(true)
    await start.click()
    await chooseDevice()
    release?.()
    const login = page.getByRole('dialog', { name: '登录 ChatGPT', exact: true })
    await login.getByRole('alert').waitFor()
    expect(await page.content()).not.toContain('secret-fixture-error')
    await snapshot('failed')
    await expect.poll(() => login.getByRole('button', { name: '重试', exact: true }).isEnabled()).toBe(true)
    await login.getByRole('button', { name: '关闭', exact: true }).last().click()
    expect(consoleWatch.pageErrors).toEqual([])
    expect(consoleWatch.warnings).toEqual([])
  })
})
