/** Cross-session messaging over the real Agent loop, Session log, and tool executor. */

import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionHeader, type UserMessage } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MockAdapter, textResponse } from './support/mock-adapter.ts'
import * as SessionMessenger from '../src/index.ts'
import type { Config } from '../src/types.ts'

/** Preset registry stand-in: a mounted roster that knows no preset, as a fresh profile has none. */
class UnavailablePresets extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agentPresets')
  }

  /** Reject every composition the way an unknown preset id does. */
  mount(): Promise<never> {
    return Promise.reject(new Error('unknown Agent preset: absent-preset'))
  }
}

const SIGNAL = new AbortController().signal
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function mount(
  ctx: Context,
  storageRoot: string,
  config: Config,
  options: { presets?: boolean; titles?: boolean } = {},
): Promise<void> {
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  // The testkit already mounts the projection registry; this adds the unit
  // that folds a title and the service that writes one.
  if (options.titles === true) {
    await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.presets === true) await ctx.plugin(UnavailablePresets)
  await ctx.plugin(SessionMessenger, config)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 24 }, () => textResponse('ack'))))
}

/** Store one completed Session in a context that is then disposed, so the Host does not run it. */
async function seedStoredTarget(storageRoot: string): Promise<void> {
  const seeder = new Context()
  await mount(seeder, storageRoot, {})
  const seeded = await seeder.agentLoop.create(
    SessionId('session-b'), { provider: 'mock', model: 'mock' }, { cwd: storageRoot },
  )
  seeded.followup(createUserMessage({ content: [{ type: 'text', text: 'seed' }], source: { kind: 'user' } }))
  await seeded.whenIdle()
  await seeder.fiber.dispose()
}

async function setup(
  config: Config = {},
  options: { receiver?: 'live' | 'stored'; presets?: boolean; titles?: boolean } = {},
) {
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-session-messenger-'))
  roots.push(storageRoot)
  const receiverMode = options.receiver ?? 'live'
  if (receiverMode === 'stored') await seedStoredTarget(storageRoot)
  const ctx = new Context()
  contexts.push(ctx)
  await mount(ctx, storageRoot, config, {
    ...options.presets === true ? { presets: true } : {},
    ...options.titles === true ? { titles: true } : {},
  })
  const sender = await ctx.agentLoop.create(SessionId('session-a'), { provider: 'mock', model: 'mock' }, { cwd: storageRoot })
  const receiver = receiverMode === 'live'
    ? await ctx.agentLoop.create(SessionId('session-b'), { provider: 'mock', model: 'mock' }, { cwd: storageRoot })
    : undefined
  return { ctx, sender, receiver, storageRoot }
}

function call(
  ctx: Context,
  agent: Awaited<ReturnType<typeof setup>>['sender'] | undefined,
  name: string,
  args: Record<string, string | number>,
) {
  return executeModelToolFixture(ctx, {
    callId: ToolCallId('call-1'),
    name,
    arguments: args,
    signal: SIGNAL,
    ...(agent === undefined ? {} : { agent }),
  })
}

function spliced(events: readonly SessionEvent[]): readonly UserMessage[] {
  return events
    .filter(event => event.type === 'agent/inbox/spliced')
    .flatMap(event => event.data.inserted)
}

describe('cross-session delivery', () => {
  it('delivers one message into another main agent and records the sender', async () => {
    const { ctx, sender, receiver } = await setup()
    const result = await call(ctx, sender, 'send_session_message', { sessionId: 'session-b', message: 'hello there' })

    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ delivered: true, targetSessionId: 'session-b' })
    await receiver!.whenIdle()
    const delivered = spliced(receiver!.session.snapshotEvents())
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.source).toMatchObject({
      kind: 'session-message',
      form: 'relay',
      senderSessionId: 'session-a',
    })
    expect(delivered[0]!.content).toEqual([
      { type: 'text', text: 'Message from session session-a:' },
      { type: 'text', text: 'hello there' },
    ])
  })

  it('resumes a stored target that this Host does not run', async () => {
    const { ctx, sender } = await setup({}, { receiver: 'stored' })
    expect(ctx.agents.get(SessionId('session-b'))).toBeUndefined()

    const result = await call(ctx, sender, 'send_session_message', { sessionId: 'session-b', message: 'wake up' })

    expect(result.isError).toBe(false)
    const resumed = ctx.agents.get(SessionId('session-b'))
    expect(resumed).toBeDefined()
    await resumed!.whenIdle()
    expect(spliced(resumed!.session.snapshotEvents()).at(-1)?.content.at(-1)).toEqual({ type: 'text', text: 'wake up' })
  })

  it('rejects a Session messaging itself', async () => {
    const { ctx, sender } = await setup()
    const result = await call(ctx, sender, 'send_session_message', { sessionId: 'session-a', message: 'loop' })

    expect(result.isError).toBe(true)
    expect(result.content.at(0)).toMatchObject({ type: 'text' })
    expect(spliced(sender.session.snapshotEvents())).toHaveLength(0)
  })

  it('rejects a Session id this Host does not store', async () => {
    const { ctx, sender } = await setup()
    const result = await call(ctx, sender, 'send_session_message', { sessionId: 'session-missing', message: 'anyone' })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('session-missing')
  })

  it('rejects a delegated child Session as a target', async () => {
    const { ctx, sender } = await setup()
    ctx.sessions.create(SessionId('session-child'), {
      meta: { parentSession: SessionId('session-a'), origin: 'subagent', delegationDepth: 1 },
    })

    const result = await call(ctx, sender, 'send_session_message', { sessionId: 'session-child', message: 'child' })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('delegated child')
  })

  it('rejects a message above the deployment byte limit', async () => {
    const { ctx, sender } = await setup({ maxMessageBytes: 8 })
    const result = await call(ctx, sender, 'send_session_message', { sessionId: 'session-b', message: 'far too many bytes' })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('deployment limit is 8')
  })

  it('reports a target that cannot be resumed', async () => {
    const { ctx, sender } = await setup({}, { receiver: 'stored' })
    vi.spyOn(ctx.agents, 'resume').mockRejectedValue(new Error('persistence offline'))

    const result = await call(ctx, sender, 'send_session_message', { sessionId: 'session-b', message: 'anyone' })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('persistence offline')

    vi.spyOn(ctx.agents, 'resume').mockRejectedValue('adapter refused')
    const opaque = await call(ctx, sender, 'send_session_message', { sessionId: 'session-b', message: 'anyone' })
    expect(opaque.isError).toBe(true)
    expect(JSON.stringify(opaque.content)).toContain('adapter refused')
  })

  it('composes the recorded Agent preset when a preset registry is mounted', async () => {
    const { ctx, sender } = await setup({}, { receiver: 'stored', presets: true })

    const result = await call(ctx, sender, 'send_session_message', { sessionId: 'session-b', message: 'anyone' })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('could not be resumed')
    expect(JSON.stringify(result.content)).toContain('absent-preset')
  })

  it('reports a delivery the Session log did not acknowledge', async () => {
    const { ctx, sender } = await setup()
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(false)

    const result = await call(ctx, sender, 'send_session_message', { sessionId: 'session-b', message: 'hello' })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('did not acknowledge')
  })

  it('rejects a call with no calling Agent', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, undefined, 'send_session_message', { sessionId: 'session-b', message: 'hello' })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('live calling Agent')
  })
})

describe('Session catalog', () => {
  it('lists every stored main Session except the caller', async () => {
    const { ctx, sender, storageRoot } = await setup()
    const childMeta = {
      cwd: storageRoot,
      parentSession: SessionId('session-a'),
      origin: 'subagent',
      delegationDepth: 1,
    } as Pick<SessionHeader, 'cwd'>
    await ctx.agentLoop.create(SessionId('session-child'), { provider: 'mock', model: 'mock' }, childMeta)

    const result = await call(ctx, sender, 'list_sessions', {})

    expect(result.isError).toBe(false)
    const rows = (result.value as { sessions: { sessionId: string; live: boolean }[] }).sessions
    expect(rows.map(row => row.sessionId)).toEqual(['session-b'])
    expect(rows[0]!.live).toBe(true)
  })

  it('applies deployment defaults when the Loader passes no configuration', async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-session-messenger-'))
    roots.push(storageRoot)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    SessionMessenger.apply(ctx, {})
    ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 4 }, () => textResponse('ack'))))
    const sender = await ctx.agentLoop.create(SessionId('session-a'), { provider: 'mock', model: 'mock' }, { cwd: storageRoot })

    const listed = await call(ctx, sender, 'list_sessions', {})
    expect(listed.isError).toBe(false)
    expect(listed.value).toEqual({ sessions: [] })

    const sent = await call(ctx, sender, 'send_session_message', { sessionId: 'session-a', message: 'x' })
    expect(sent.isError).toBe(true)
  })

  it('omits the working directory of a Session that recorded none', async () => {
    const { ctx, sender } = await setup()
    const bare = await ctx.agentLoop.create(SessionId('session-nocwd'), { provider: 'mock', model: 'mock' })
    bare.followup(createUserMessage({ content: [{ type: 'text', text: 'bare' }], source: { kind: 'user' } }))
    await bare.whenIdle()

    const result = await call(ctx, sender, 'list_sessions', {})

    expect(result.isError).toBe(false)
    const rows = (result.value as { sessions: { sessionId: string; cwd?: string }[] }).sessions
    expect(rows.map(row => row.sessionId)).toContain('session-nocwd')
    expect(rows.find(row => row.sessionId === 'session-nocwd')).not.toHaveProperty('cwd')
  })

  it('honors the deployment row limit', async () => {
    const { ctx, sender } = await setup({ maxTargets: 1 })
    const result = await call(ctx, sender, 'list_sessions', { limit: 5 })

    expect(result.isError).toBe(false)
    const rows = (result.value as { sessions: { sessionId: string }[] }).sessions
    expect(rows).toHaveLength(1)
  })

  it('checks one id without reading the whole catalog', async () => {
    const { ctx, sender } = await setup()
    const other = await ctx.agentLoop.create(SessionId('session-c'), { provider: 'mock', model: 'mock' })
    other.followup(createUserMessage({ content: [{ type: 'text', text: 'other' }], source: { kind: 'user' } }))
    await other.whenIdle()

    const hit = await call(ctx, sender, 'list_sessions', { sessionId: 'session-c' })
    expect(hit.isError).toBe(false)
    expect((hit.value as { sessions: { sessionId: string }[] }).sessions.map(row => row.sessionId)).toEqual(['session-c'])

    const miss = await call(ctx, sender, 'list_sessions', { sessionId: 'session-typo' })
    expect(miss.isError).toBe(false)
    expect(miss.value).toEqual({ sessions: [] })
  })

  it('returns the title a projection holds, without folding the Session log', async () => {
    const { ctx, sender, receiver } = await setup({}, { titles: true })
    const titled = receiver as NonNullable<typeof receiver>
    ctx.sessionTitle.rename(titled.session, 'Weekly rollup')
    await titled.whenIdle()

    // The title unit folds only while the registry drives the Session, so a
    // title present here proves the catalog read a projection rather than a log.
    const liveSnapshot = vi.spyOn(ctx.sessionProjections, 'snapshot')
    const result = await call(ctx, sender, 'list_sessions', { sessionId: 'session-b' })

    expect(result.isError).toBe(false)
    const rows = (result.value as { sessions: { sessionId: string; title?: string }[] }).sessions
    expect(rows).toEqual([expect.objectContaining({ sessionId: 'session-b', title: 'Weekly rollup' })])
    expect(liveSnapshot).toHaveBeenCalled()
  })

  it('omits the title for a Session no projection has titled', async () => {
    const { ctx, sender } = await setup({}, { titles: true })

    const result = await call(ctx, sender, 'list_sessions', {})

    expect(result.isError).toBe(false)
    const rows = (result.value as { sessions: { title?: string }[] }).sessions
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row).not.toHaveProperty('title')
  })

  it('omits the title when no title unit is registered', async () => {
    const { ctx, sender } = await setup()

    const result = await call(ctx, sender, 'list_sessions', {})

    expect(result.isError).toBe(false)
    const rows = (result.value as { sessions: { sessionId?: string; title?: string }[] }).sessions
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row).not.toHaveProperty('title')
      expect(row.sessionId).toBeDefined()
    }
  })

  it('rejects a catalog read with no calling Agent', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, undefined, 'list_sessions', {})

    expect(result.isError).toBe(true)
  })
})
