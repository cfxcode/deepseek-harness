/** Profile patch edits and credential updates reach the next real adapter request. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createMessage, createUserMessage, userAgent } from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

/** One text block, then a tool call truncated by the output-token ceiling. */
const truncatedToolCallEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"partial"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"echo","arguments":"{\\"text\\":"}}]},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}',
  '[DONE]',
]

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

/** Boot the dormant composition: a bare `llm-pi-ai` row with no config at all. */
async function loadComposition(): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-composition-'))
  await writeFile(join(root, '.credentials.yaml'), 'version: 1\nrefs:\n  PI_COMPOSITION_KEY: key-from-store\n', { mode: 0o600 })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    debounceMs: 10',
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  const patchPath = await profileComposition(ctx, root, configPath)
  return { ctx, settingsPath: patchPath }
}

describe('llm-pi-ai real dormant composition', () => {
  it('keeps conversation and summary responses above the Codex catalog capacity', async () => {
    const payload = Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' },
    })).toString('base64url')
    vi.stubEnv('PI_COMPOSITION_KEY', `fixture.${payload}.signature`)
    const item = {
      type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Review complete.', annotations: [] }],
    }
    const events = [
      JSON.stringify({ type: 'response.created', response: { id: 'resp_fixture' } }),
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } }),
      JSON.stringify({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }),
      JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Review complete.' }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_fixture', status: 'completed', output: [item],
        usage: { input_tokens: 379929, output_tokens: 944, total_tokens: 380873, input_tokens_details: { cached_tokens: 379648 } },
      } }),
    ]
    const server = await mockServer([{ events }, { events }])
    const { ctx, settingsPath } = await loadComposition()
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      openai-codex:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '        transport: sse',
      '        models:',
      '          - id: gpt-6-astra',
      '            contextWindow: 272000',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai-codex'])
    }, { timeout: 5000 })

    for (const purpose of [undefined, 'compaction'] as const) {
      const result = await assemble(ctx, {
        provider: 'openai-codex', model: 'gpt-6-astra', messages: [],
        ...purpose === undefined ? {} : { purpose },
      })
      expect(result.finish).toEqual({ kind: 'stop' })
      expect(result.message.content).toEqual([{ type: 'text', text: 'Review complete.' }])
      expect(result.usage).toEqual({ inputTokens: 281, outputTokens: 944, totalTokens: 380873, cacheReadTokens: 379648 })
    }
    expect(server.paths).toEqual(['/codex/responses', '/codex/responses'])
  })

  it('boots with zero routes and registers one the moment settings supply a profile', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition()

    // The shipped posture: the adapter exists, no route does.
    expect(ctx.llm.listProviders()).toEqual([])

    // Exactly what the web Models page leaves on disk.
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer key-from-store')
  })

  it('uses settings-only route headers for model discovery', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ body: JSON.stringify({ data: [{ id: 'acme-private' }] }) }])
    const { ctx, settingsPath } = await loadComposition()

    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      acme-gateway:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      '        api: openai-completions',
      `        baseURL: ${server.url}`,
      '        headers:',
      '          X-Company-Code: private-tenant',
      '          Accept: text/plain',
      '          User-Agent: deployment-owned',
      '        models:',
      '          - id: acme-bootstrap',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['acme-gateway'])
    }, { timeout: 5000 })

    await expect(ctx.llm.discoverModels('llm-pi-ai', {
      provider: 'acme-gateway',
      baseURL: server.url,
      api: 'openai-completions',
    })).resolves.toEqual([{ id: 'acme-private', name: 'acme-private' }])
    expect(server.paths).toEqual(['/models'])
    expect(server.headers[0]?.['x-company-code']).toBe('private-tenant')
    expect(server.headers[0]?.authorization).toBe('Bearer key-from-store')
    expect(server.headers[0]?.accept).toBe('application/json')
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
  })

  it('continues natively after max-token assembly drops a tool call, with pruned replay metadata', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([
      { events: truncatedToolCallEvents },
      { events: textEvents },
    ])
    const { ctx, settingsPath } = await loadComposition()
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    const truncated = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      messages: [],
    })
    expect(truncated.finish).toEqual({ kind: 'max-tokens' })
    expect(truncated.message.content).toEqual([{ type: 'text', text: 'partial' }])
    expect(truncated.message.source).toEqual({
      kind: 'model',
      provider: 'deepseek',
      model: 'deepseek-flash',
      replayState: {
        response: {
          kind: 'pi-ai',
          version: 2,
          api: 'openai-completions',
          provider: 'deepseek',
          model: 'deepseek-flash',
          stopReason: 'length',
        },
        blocks: [{ type: 'text' }],
      },
    })

    const continued = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      messages: [
        truncated.message,
        createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }),
      ],
    })
    expect(continued.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]).toMatchObject({
      messages: [
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'continue' },
      ],
    })
    const followup = server.requests[1] as { messages?: unknown[] }
    expect(followup.messages?.[0]).not.toHaveProperty('tool_calls')
  })

  it('continues a legacy session whose stored replay state no longer matches its content', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition()
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    // A pre-envelope session log entry: max-token assembly dropped the tool
    // call from content while the flat v1 state still describes both blocks.
    const poisoned = createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      source: {
        kind: 'model',
        ...{
          provider: 'deepseek',
          model: 'deepseek-flash',
          replayState: {
            kind: 'pi-ai',
            version: 1,
            api: 'openai-completions',
            provider: 'deepseek',
            model: 'deepseek-flash',
            stopReason: 'length',
            blocks: [{ type: 'text' }, { type: 'tool-call' }],
          },
        },
      },
    })
    const continued = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      messages: [
        poisoned,
        createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }),
      ],
    })
    expect(continued.finish).toEqual({ kind: 'stop' })
    expect(continued.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests[0]).toMatchObject({
      messages: [
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'continue' },
      ],
    })
  })
})
