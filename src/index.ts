/**
 * Cross-session messaging between the main agents of existing Sessions.
 *
 * The model tools address a target by session id, deliver one user-role message
 * into the target Agent's inbox, and resume a target Session that this Host has
 * not loaded. A delivered message records this package's `session-message`
 * source, so the target log and history name the sending Session.
 * @module @deepseek-ai/dsh-experimental-session-messenger
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
// Type-only: registers the `sessionProjections` / `sessionProjectionCache`
// Context merges and the `title` projection key this catalog reads.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-title'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionMessageError } from './error.ts'
import type { Config as MessengerConfig, SessionTargetRow } from './types.ts'

export type * from './types.ts'
export { SessionMessageError } from './error.ts'

/** Plugin name used by Loader diagnostics. */
export const name = 'session-messenger'

/** Host services this plugin consumes. */
export const inject = ['tools', 'agents', 'sessions', 'sessionPersistence']

const DEFAULT_MAX_MESSAGE_BYTES = 65_536
const DEFAULT_MAX_TARGETS = 50

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<MessengerConfig> = z.object({
  maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
  maxTargets: z.number().step(1).min(1).max(500).default(DEFAULT_MAX_TARGETS),
})

interface ResolvedConfig {
  readonly maxMessageBytes: number
  readonly maxTargets: number
}

/** Apply the validated defaults for the two deployment bounds. */
function resolveConfig(config: MessengerConfig): ResolvedConfig {
  return {
    maxMessageBytes: config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
    maxTargets: config.maxTargets ?? DEFAULT_MAX_TARGETS,
  }
}

const SEND_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    delivered: { type: 'boolean', required: true },
    targetSessionId: { type: 'string', required: true },
    messageId: { type: 'string', required: true },
    targetRunning: { type: 'boolean', required: true },
  },
} as const

const LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessions: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          title: { type: 'string' },
          cwd: { type: 'string' },
          live: { type: 'boolean', required: true },
          running: { type: 'boolean', required: true },
          createdAt: { type: 'string', required: true },
        },
      },
    },
  },
} as const

/** Render one structured result as its JSON text for the model. */
function jsonText(value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value, null, 1) }]
}

/** Reject a call that carries no live calling Agent. */
function callerOf(exec: ToolRunContext): Agent {
  const agent = exec.agent
  if (agent === undefined) {
    throw new SessionMessageError('Cross-session messaging needs a live calling Agent.', 'SESSION_MESSAGE_NO_CALLER')
  }
  return agent
}

/** Reject every target that is not the main Agent of a top-level Session. */
function assertMainSession(header: SessionHeader, sessionId: SessionId): void {
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) {
    throw new SessionMessageError(
      `Session "${sessionId}" is a delegated child; cross-session messages reach main-agent Sessions only.`,
      'SESSION_MESSAGE_TARGET_IS_SUBAGENT',
    )
  }
}

/** Read one Session header without resuming its Agent. */
async function headerOf(ctx: Context, sessionId: SessionId): Promise<SessionHeader | undefined> {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) return live.header
  const snapshot = await ctx.sessionPersistence.stat(sessionId)
  return snapshot?.header
}

/** Resolve the target main Agent, resuming its Session when this Host has not loaded it. */
async function resolveTarget(ctx: Context, sessionId: SessionId, caller: Agent, signal: AbortSignal): Promise<Agent> {
  if (sessionId === caller.id) {
    throw new SessionMessageError('A Session cannot send a message to itself.', 'SESSION_MESSAGE_SELF')
  }
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) {
    assertMainSession(live.session.header, sessionId)
    return live
  }
  const header = await headerOf(ctx, sessionId)
  if (header === undefined) {
    throw new SessionMessageError(`No Session "${sessionId}" exists in this Host.`, 'SESSION_MESSAGE_TARGET_NOT_FOUND')
  }
  assertMainSession(header, sessionId)
  const presets = ctx.get('agentPresets')
  const setup = presets === undefined
    ? undefined
    : async (agentCtx: Context): Promise<void> => { await presets.mount(agentCtx, header.agentPreset) }
  try {
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      signal,
      ...(setup === undefined ? {} : { setup }),
    })
    return handle.agent
  } catch (error: unknown) {
    throw new SessionMessageError(
      `Session "${sessionId}" could not be resumed: ${error instanceof Error ? error.message : String(error)}`,
      'SESSION_MESSAGE_TARGET_UNREACHABLE',
    )
  }
}

/** Projection keys worth reading for a catalog row: the title alone. */
const TITLE_KEYS = ['title'] as const

/** Read the title a projection already holds, never folding a Session log to derive one. */
function titleReader(ctx: Context): (header: SessionHeader) => string | undefined {
  const projections = ctx.get('sessionProjections')
  const cache = ctx.get('sessionProjectionCache')
  const cached = cache?.cachedSnapshot.bind(cache)
  return (header) => {
    const live = ctx.sessions.get(header.id)
    const values = live !== undefined && projections !== undefined
      ? projections.snapshot(live, TITLE_KEYS).values
      : cached?.(header, TITLE_KEYS)?.values
    const title = values?.title
    return typeof title === 'string' && title.length > 0 ? title : undefined
  }
}

/** Read the addressable Session catalog from stored Session headers and live Agents. */
async function catalog(ctx: Context, signal: AbortSignal, limit: number): Promise<SessionTargetRow[]> {
  const stored = await ctx.sessionPersistence.list({ signal })
  const titleOf = titleReader(ctx)
  const rows: SessionTargetRow[] = []
  for (const snapshot of stored) {
    const header = snapshot.header
    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) continue
    const live = ctx.agents.get(header.id)
    const title = titleOf(header)
    rows.push({
      sessionId: header.id,
      ...(title === undefined ? {} : { title }),
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      live: live !== undefined,
      running: live?.status === 'running',
      createdAt: new Date(header.createdAt).toISOString(),
    })
  }
  rows.sort((left, right) => Number(right.live) - Number(left.live) || right.createdAt.localeCompare(left.createdAt))
  return rows.slice(0, limit)
}

/** Register the two model tools. */
export function apply(ctx: Context, config: MessengerConfig = {}): void {
  const resolved = resolveConfig(config)

  ctx.tools.register(defineTool({
    name: 'list_sessions',
    description: 'List Sessions in this Host with the exact ids send_session_message accepts. '
      + 'Fields: sessionId, title, cwd, live, running, createdAt. Pass sessionId to check one id instead of reading the whole catalog. '
      + 'title is display text and may repeat; sessionId is the only address send_session_message accepts.',
    parameters: {
      sessionId: { type: 'string', description: 'Return only this Session, to verify one id without reading the whole catalog.' },
      limit: { type: 'integer', description: 'Maximum rows to return. Defaults to the deployment limit.' },
    },
    output: { schema: LIST_VALUE_SCHEMA, render: (_args: unknown, value: unknown) => jsonText(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const caller = callerOf(exec)
      const limit = Math.min(args.limit ?? resolved.maxTargets, resolved.maxTargets)
      const rows = (await catalog(ctx, exec.signal, limit))
        .filter(row => row.sessionId !== caller.id)
        .filter(row => args.sessionId === undefined || row.sessionId === args.sessionId)
      return { sessions: rows }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'send_session_message',
    description: 'Send one message to the main agent of another existing Session. '
      + 'Arguments: sessionId (the exact id from list_sessions or from the user; a Session title is not accepted) and message (self-contained text). '
      + 'The target resumes when this Host has not loaded it, and receives the message as a user-role message that names this Session as the sender.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Exact target Session id, as returned by list_sessions or given by the user.' },
      message: { type: 'string', required: true, description: 'Self-contained message for the target session.' },
    },
    output: { schema: SEND_VALUE_SCHEMA, render: (_args: unknown, value: unknown) => jsonText(value) },
    async execute(args, exec) {
      const caller = callerOf(exec)
      const bytes = Buffer.byteLength(args.message, 'utf8')
      if (bytes > resolved.maxMessageBytes) {
        throw new SessionMessageError(
          `The message is ${bytes} bytes; the deployment limit is ${resolved.maxMessageBytes}.`,
          'SESSION_MESSAGE_TOO_LARGE',
        )
      }
      const target = await resolveTarget(ctx, brandString<SessionId>(args.sessionId), caller, exec.signal)
      const message = createUserMessage({
        content: [
          { type: 'text', text: `Message from session ${caller.id}:` },
          { type: 'text', text: args.message },
        ],
        source: { kind: 'session-message', form: 'relay', senderSessionId: caller.id },
      })
      target.followup(message)
      const flushed = await ctx.sessions.flush(target.session)
      if (!flushed) {
        throw new SessionMessageError(
          `Session "${target.id}" did not acknowledge the delivered message.`,
          'SESSION_MESSAGE_TARGET_UNREACHABLE',
        )
      }
      return {
        delivered: true,
        targetSessionId: target.id,
        messageId: message.id,
        targetRunning: target.status === 'running',
      }
    },
  }))
}
