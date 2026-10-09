/** Completed Codex HTTP responses whose usage exceeds the configured catalog. */
import { zstdDecompressSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

/** Cordis plugin name. */
export const name = 'codex-response-fixture'

/** This fixture replaces only the external HTTP boundary. */
export const inject = []

/**
 * Supply deterministic Codex SSE while retaining the real adapter and loop.
 * @param ctx - Cordis context owning the fetch override.
 */
export function apply(ctx) {
  const records = readFileSync(process.env.DSH_SNAPSHOT_FILE, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  const assistant = records.find(record => record.type === 'assistant/message')?.data
  if (assistant === undefined) throw new Error('Codex fixture has no recorded assistant response')
  const text = assistant.message.content.find(block => block.type === 'text')?.text
  if (text === undefined) throw new Error('Codex fixture has no recorded text')
  const usage = assistant.usage
  const responseId = assistant.message.source.replayState.response.responseId
  const previous = globalThis.fetch
  const fixtureFetch = async (url, options) => {
    if (String(url) !== 'https://chatgpt.com/backend-api/codex/responses') {
      throw new Error(`unexpected fixture URL: ${String(url)}`)
    }
    const headers = new Headers(options.headers)
    const body = headers.get('content-encoding') === 'zstd'
      ? zstdDecompressSync(options.body).toString('utf8')
      : String(options.body)
    const request = JSON.parse(body)
    if (request.model !== assistant.message.source.model) throw new Error(`unexpected fixture model: ${request.model}`)
    const item = {
      type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    }
    const events = [
      { type: 'response.created', response: { id: responseId } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: {
        id: responseId, status: 'completed', output: [item],
        usage: {
          input_tokens: usage.inputTokens + (usage.cacheReadTokens ?? 0),
          output_tokens: usage.outputTokens, total_tokens: usage.totalTokens,
          input_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
        },
      } },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  ctx.effect(() => {
    globalThis.fetch = fixtureFetch
    return () => { globalThis.fetch = previous }
  })
}
