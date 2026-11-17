import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/** Stream the given text as one text block, then finish normally. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Script entry that streams the given chunks, then hangs until aborted. */
export interface HangAfter {
  hangAfter: StreamChunk[]
}

/**
 * Mock adapter driven by a script: each model call consumes the next entry.
 * An entry may be chunks, a function computing them from the request, a
 * `'hang'` marker that streams one chunk then waits until aborted, or a
 * {@link HangAfter} scripting the exact chunks delivered before the hang.
 */
export class MockAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(
    private script: (StreamChunk[] | ((options: GenerateOptions) => StreamChunk[]) | 'hang' | HangAfter)[],
  ) {
    super()
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('MockAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('aborted')); return }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    if (typeof entry === 'object' && !Array.isArray(entry) && 'hangAfter' in entry) {
      for (const chunk of entry.hangAfter) yield chunk
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('aborted')); return }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}
