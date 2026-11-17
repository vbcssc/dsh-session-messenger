/**
 * Vocabulary for cross-session messaging: the sender attribution a delivered
 * message records and the values the model tools return.
 *
 * @module @deepseek-ai/dsh-experimental-session-messenger/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Producer source recorded on every message this package delivers into another
 * Session. `relay` states that the content is a message another agent
 * addressed to this one; consumers that do not know the kind fall through to
 * opaque content.
 */
export interface SessionMessageSource {
  /** Source discriminator declared by this producer. */
  readonly kind: 'session-message'
  /** Producer-declared context form: a message another agent addressed to this one. */
  readonly form?: 'relay'
  /** Session whose main agent sent the message. */
  readonly senderSessionId: SessionId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'session-message': SessionMessageSource
  }
}

/** Deployment-owned bounds for one send and one catalog read. */
export interface Config {
  /** Maximum UTF-8 bytes in one delivered message. Defaults to 65536. */
  maxMessageBytes?: number
  /** Maximum Session rows returned by one catalog read. Defaults to 50. */
  maxTargets?: number
}

/** One addressable Session as the model sees it. */
export interface SessionTargetRow {
  /** Exact identity accepted by `send_session_message`. */
  readonly sessionId: string
  /**
   * Display label from the registered title projection, when this Host can
   * serve one. Absent for a Session no projection has titled yet — a title is
   * display text and the id stays the only address.
   */
  readonly title?: string
  /** Working directory the Session was created in, when recorded. */
  readonly cwd?: string
  /** Whether this Host currently holds a live Agent for the Session. */
  readonly live: boolean
  /** Whether the Session is running a turn. */
  readonly running: boolean
  /** ISO 8601 creation time recorded in the Session header. */
  readonly createdAt: string
}

/** Stable failure codes of one cross-session send. */
export type SessionMessageErrorCode =
  | 'SESSION_MESSAGE_SELF'
  | 'SESSION_MESSAGE_TARGET_NOT_FOUND'
  | 'SESSION_MESSAGE_TARGET_IS_SUBAGENT'
  | 'SESSION_MESSAGE_TARGET_UNREACHABLE'
  | 'SESSION_MESSAGE_TOO_LARGE'
  | 'SESSION_MESSAGE_NO_CALLER'
