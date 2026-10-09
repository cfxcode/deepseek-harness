/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque login capability, delivered only to the browser that began the attempt. */
export type CodexLoginAttemptId = Branded<'CodexLoginAttemptId'>

/** Safe subscription-login metadata; configured means a grant is stored, not that it was validated remotely. */
export interface CodexLoginInfo {
  readonly available: boolean
  readonly configured: boolean
  readonly writable: boolean
  readonly inFlight: boolean
}

/** One OAuth progress snapshot. Credential payloads and provider failure bodies never ride it. */
export interface CodexLoginView {
  readonly id: CodexLoginAttemptId
  readonly status: 'running' | 'authorized' | 'cancelled' | 'failed'
  readonly revision: number
  readonly notice?: { readonly message: string; readonly url?: string; readonly code?: string }
  readonly prompt?: {
    readonly kind: 'text' | 'secret' | 'select'
    readonly message: string
    readonly placeholder?: string
    readonly options?: readonly { readonly id: string; readonly label: string }[]
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}
