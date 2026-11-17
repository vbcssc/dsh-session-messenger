/**
 * Typed failure of one cross-session send or catalog read.
 *
 * @module @deepseek-ai/dsh-experimental-session-messenger/error
 */

import type { SessionMessageErrorCode } from './types.ts'

/** One rejected cross-session operation with a stable machine-routing code. */
export class SessionMessageError extends Error {
  /**
   * @param message - actionable account of the rejection.
   * @param code - stable code the caller may branch on.
   */
  constructor(message: string, readonly code: SessionMessageErrorCode) {
    super(message)
    this.name = 'SessionMessageError'
  }
}
