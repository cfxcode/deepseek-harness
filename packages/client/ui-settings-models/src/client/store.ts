/**
 * Models settings page store: one snapshot joining the configurable-provider
 * directory (`llm/listProviders` joined with `llm/listConfigurableProviders`),
 * the settings namespaces (shared settings mirror),
 * and the referenced credentials (`credentials/describe`). The host stays the
 * single fact source — every mutation writes through the wire and the page
 * re-renders from the next describe, pushed or refetched.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  CodexLoginInfo, CodexLoginView, CredentialInfo, LlmConfigurableProvider, LlmProviderInfo, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsSchemaOperations } from './schema-operations.ts'

/**
 * Any route key walks a dict schema to the same profile node, so the lookup
 * names one that cannot collide with a configured route.
 */
const PROBE_ROUTE = '\u0000probe'

/** One provider row after joining the configurable directory with live routes. */
export interface ProviderDirectoryEntry {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly active: boolean
  readonly declared?: boolean
  readonly error?: string
}

/**
 * Join declared configurable providers with the currently registered routes.
 * @param registered - live provider routes in registration order.
 * @param directory - declared configurable providers in declaration order.
 * @returns account and official routes first, then other routes in their original order.
 */
export function joinProviderDirectory(
  registered: readonly LlmProviderInfo[],
  directory: readonly LlmConfigurableProvider[],
): ProviderDirectoryEntry[] {
  const active = new Set(registered.map(provider => provider.id))
  const declared = new Set(directory.map(entry => entry.provider))
  const rows: ProviderDirectoryEntry[] = directory.map(entry => ({
    provider: entry.provider,
    displayName: entry.displayName,
    settingsNs: entry.settingsNs,
    settingsPath: [...entry.settingsPath],
    active: active.has(entry.provider),
    ...entry.declared === undefined ? {} : { declared: entry.declared },
    ...entry.error === undefined ? {} : { error: entry.error },
  }))
  for (const provider of registered) {
    if (declared.has(provider.id)) continue
    rows.push({
      provider: provider.id,
      displayName: provider.name,
      settingsNs: '',
      settingsPath: [],
      active: true,
    })
  }
  return rows.toSorted((left, right) =>
    (left.provider === 'deepseek-account' ? 0 : left.provider === 'deepseek-official' ? 1 : 2)
      - (right.provider === 'deepseek-account' ? 0 : right.provider === 'deepseek-official' ? 1 : 2))
}

/** One provider row the page renders. */
export interface ProviderRow {
  /** Stored ChatGPT grant metadata for the built-in Codex route. */
  codexLogin?: CodexLoginInfo
  /** Account route has usable credentials for the configured inference origin. */
  accountAvailable?: boolean
  /** The directory entry (route id, display name, settings address, live state). */
  entry: ProviderDirectoryEntry
  /** Whether any layer configures this provider (its profile resolves). */
  configured: boolean
  /** Whether the user layer alone carries the profile (removal restores the base). */
  removable: boolean
  /** The credential reference the resolved profile names, when one does. */
  apiKeyEnv: string | undefined
  /** Credential state for {@link apiKeyEnv}, once described. */
  credential: CredentialInfo | undefined
  /**
   * Credential state for the page's derived `<ROUTE>_API_KEY`, described only
   * while the profile names no reference — the provider-card seat's
   * `keyConfigured` fact for dormant and keyless rows, matching the editor's
   * own derivation rule.
   */
  derivedCredential?: CredentialInfo
}

/** Page snapshot. */
export interface ModelsSettingsState {
  /** Active or most recently completed ChatGPT login. */
  codexAttempt?: CodexLoginView
  /** A transport or storage failure, rendered with localized copy. */
  codexLoginError?: boolean
  /** Login or logout has not yet settled. */
  codexBusy?: boolean
  /** The login dialog is open while its stream is starting. */
  codexSigningIn?: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay in the editor. */
  error: string | null
  /** Credential enrichment failure; provider/settings rows remain usable. */
  credentialError: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Every configurable provider joined with its configured/credential state. */
  rows: readonly ProviderRow[]
  /** Namespace views by ns, for the editor's schema/layers/secrets. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
}

/**
 * Derive the conventional credential reference for a provider route: the v1
 * page never asks for an environment-variable name, so a typed key stores
 * under this derived reference and the profile records it as `apiKeyEnv`.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * The wire protocols a hand-declared route may name, read out of the owning
 * namespace's own schema. This stays a schema read rather than a wire field so
 * the choices the page offers cannot drift from the ones the adapter accepts:
 * both come from the same `Config`.
 * @param namespace - the namespace view whose schema declares the profile shape.
 * @param schema - settings schema operations.
 * @returns the protocol identifiers, or an empty list when the schema has none.
 */
export function protocolChoices(
  namespace: SettingsNamespaceView | undefined,
  schema: SettingsSchemaOperations,
): string[] {
  if (namespace === undefined) return []
  const node = schema.nodeAtPath(schema.rehydrate(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  const list = (node as { type?: string; list?: readonly { value?: unknown }[] } | undefined)
  if (list?.type !== 'union' || list.list === undefined) return []
  return list.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/** The credential reference a resolved profile names (its `apiKeyEnv` field). */
function apiKeyEnvOf(
  namespace: SettingsNamespaceView | undefined,
  path: readonly string[],
  schema: SettingsSchemaOperations,
): string | undefined {
  if (namespace === undefined) return undefined
  const profile = schema.getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** The models settings page controller (one per settings surface). */
export class ModelsSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ModelsSettingsState> = createSnapshotStore<ModelsSettingsState>({
    status: 'idle', error: null, credentialError: null, writable: false, rows: [], namespaces: new Map(),
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0
  private loginController: AbortController | undefined
  private loginTask: Promise<void> | undefined
  private disposed = false

  /** Start one ChatGPT login; the page snapshot carries progress and prompts. */
  startCodexLogin(): void {
    if (this.loginTask !== undefined || this.disposed || this.store.getSnapshot().codexBusy) return
    const controller = new AbortController()
    this.loginController = controller
    this.store.update((s) => { delete s.codexAttempt; s.codexBusy = true; s.codexSigningIn = true; s.codexLoginError = false })
    const task = (async () => {
      try {
        for await (const view of this.ctx.remote.codexLogin.signIn(controller.signal)) {
          if (this.disposed || controller.signal.aborted) break
          this.store.update((s) => { s.codexAttempt = view })
        }
      } catch {
        if (!this.disposed && !controller.signal.aborted) this.store.update((s) => { s.codexLoginError = true })
      } finally {
        if (this.loginController === controller) this.loginController = undefined
        if (!this.disposed) {
          this.store.update((s) => { s.codexBusy = false; s.codexSigningIn = false })
          await this.load()
        }
      }
    })()
    this.loginTask = task
    void task.finally(() => { if (this.loginTask === task) this.loginTask = undefined }).catch(() => {
      if (!this.disposed) this.store.update((s) => { s.codexLoginError = true })
    })
  }

  /**
   * Submit the current login answer and forget it locally immediately.
   * @param value - selected method or typed callback answer.
   * @returns once the host accepts or refuses the answer; failures stay on the page.
   */
  async answerCodexLogin(value: string): Promise<void> {
    const view = this.store.getSnapshot().codexAttempt
    if (view?.prompt === undefined || view.status !== 'running') return
    this.store.update((s) => { s.codexLoginError = false })
    try {
      const result = await this.ctx.remote.codexLogin.respond(view.id, view.revision, value)
      if (!result.ok) this.store.update((s) => { if (s.codexAttempt?.id === view.id) s.codexLoginError = true })
      else this.store.update((s) => {
        if (s.codexAttempt?.id === view.id && s.codexAttempt.revision === view.revision) {
          const { prompt: _prompt, ...rest } = s.codexAttempt
          s.codexAttempt = rest
        }
      })
    } catch {
      this.store.update((s) => { if (s.codexAttempt?.id === view.id) s.codexLoginError = true })
    }
  }

  /** Withdraw login when its dialog closes; keep the prior stored grant. */
  cancelCodexLogin(): void { this.loginController?.abort() }

  /** Dismiss the most recent login result after any active attempt is withdrawn. */
  dismissCodexLogin(): void {
    this.cancelCodexLogin()
    this.store.update((s) => { delete s.codexAttempt; s.codexSigningIn = false; s.codexLoginError = false })
  }

  /**
   * Remove only the Codex grant and refresh the page; failures remain visible.
   * @returns after storage and refresh have settled.
   */
  async signOutCodex(): Promise<void> {
    if (this.store.getSnapshot().codexBusy) return
    this.store.update((s) => { s.codexBusy = true; s.codexLoginError = false; delete s.codexAttempt })
    try {
      const result = await this.ctx.remote.codexLogin.signOut()
      if (!result.ok) this.store.update((s) => { s.codexLoginError = true })
      await this.load()
    } catch {
      this.store.update((s) => { s.codexLoginError = true })
    } finally { this.store.update((s) => { s.codexBusy = false }) }
  }

  /**
   * Withdraw the login stream when the plugin leaves.
   * @returns after the stream has settled.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.generation++
    this.cancelCodexLogin()
    await this.loginTask?.catch(() => undefined)
  }

  /**
   * @param ctx - the page plugin's context, whose `remote.llm` and
   * `remote.credentials` namespaces carry the directory and credential reads.
   * @param schema - settings-owned schema and immutable path operations.
   * @param describeFace - the shared mirror's describe face (namespace views and writability).
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly schema: SettingsSchemaOperations,
    private readonly describeFace: SettingsDescribeFace,
  ) {}

  /**
   * Refresh the whole page snapshot: the provider directory and the mirror's
   * settings answer in parallel, then one batched credential describe over
   * every referenced ref. Provider failure or absence of an initial settings
   * answer keeps the last good rows and surfaces an error; a failed settings
   * refresh reuses the mirror's held view.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    const [registered, declared] = await Promise.all([
      this.ctx.remote.llm.listProviders(),
      this.ctx.remote.llm.listConfigurableProviders(),
      this.describeFace.ensure(),
    ])
    if (!registered.ok) { this.failLoad(generation, registered.error.message); return }
    if (!declared.ok) { this.failLoad(generation, declared.error.message); return }
    const mirrored = this.describeFace.getSnapshot()
    if (mirrored.view === undefined) {
      this.failLoad(generation, mirrored.error ?? 'settings are unavailable in this browser')
      return
    }
    const providers = joinProviderDirectory(registered.value, declared.value)
    const writable = mirrored.view.writable
    const views: readonly SettingsNamespaceView[] = mirrored.view.namespaces
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const rows: ProviderRow[] = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || this.schema.getPath(namespace.value, entry.settingsPath) !== undefined)
      const removable = namespace !== undefined
        && entry.settingsPath.length > 0
        && this.schema.hasPath(namespace.user, entry.settingsPath)
        && !this.schema.hasPath(namespace.base, entry.settingsPath)
      return {
        entry,
        configured,
        removable,
        apiKeyEnv: entry.provider === 'deepseek-account' ? undefined : apiKeyEnvOf(namespace, entry.settingsPath, this.schema),
        credential: undefined,
      }
    })
    if (rows.some(row => row.entry.provider === 'deepseek-account')) {
      const catalog = await this.ctx.remote.session.modelCatalog()
      for (const row of rows) {
        if (row.entry.provider === 'deepseek-account') row.accountAvailable = catalog.ok
          && catalog.value.groups.some(group => group.id === 'deepseek-account' && group.models.length > 0)
      }
    }
    if (generation !== this.generation) return
    const codex = rows.find(row => row.entry.provider === 'openai-codex' && row.entry.settingsNs === 'llm-pi-ai')
    if (codex?.configured !== true && this.loginController !== undefined) this.dismissCodexLogin()
    if (codex !== undefined) {
      const login = await this.ctx.remote.codexLogin.describe()
      if (login.ok) codex.codexLogin = login.value
    }
    const refs = [...new Set(rows.filter(row => row.entry.provider !== 'deepseek-account').map(row => row.apiKeyEnv ?? deriveKeyRef(row.entry.provider)))]
    let credentials: Record<string, CredentialInfo> = {}
    let credentialError: string | null = null
    if (refs.length > 0) {
      const response = await this.ctx.remote.credentials.describe(refs)
      // Credential state is an enrichment for the Models page: a failure
      // degrades the badge instead of failing the load. The onboarding
      // projection below retains the failure distinction.
      if (response.ok) credentials = response.value
      else credentialError = response.error.message
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.credentialError = credentialError
      s.writable = writable
      s.rows = rows.filter(row => row.entry.provider !== 'deepseek-account' || row.accountAvailable === true).map((row) => {
        if (row.entry.provider === 'deepseek-account') return row
        const named = row.apiKeyEnv === undefined ? undefined : credentials[row.apiKeyEnv]
        const derived = row.apiKeyEnv !== undefined ? undefined : credentials[deriveKeyRef(row.entry.provider)]
        return {
          ...row,
          ...named === undefined ? {} : { credential: named },
          ...derived === undefined ? {} : { derivedCredential: derived },
        }
      })
      s.namespaces = namespaces
    })
  }

  /** Publish one load's failure text, unless a newer load already took over. */
  private failLoad(generation: number, message: string): void {
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'error'
      s.error = message
    })
  }
}

/**
 * Whether a joined row can serve model requests as it stands: the route is
 * registered with the adapter registry, and whatever credential its resolved
 * profile names is stored. A profile naming no reference authenticates through
 * the provider's own path (the Bedrock chain, Vertex ADC, a gateway that needs
 * nothing), as does a live route with no settings address at all, so neither
 * owes this page a key.
 * @param row - one joined provider row.
 * @returns whether the user already has this provider to talk to.
 */
export function providerUsable(row: ProviderRow): boolean {
  if (!row.entry.active) return false
  if (row.entry.provider === 'deepseek-account') return row.accountAvailable === true
  if (row.entry.provider === 'openai-codex' && row.apiKeyEnv === undefined) return row.codexLogin?.configured === true
  if (row.apiKeyEnv === undefined) return true
  return row.credential?.configured === true
}

/** First-run onboarding readiness derived only from the shared Models join. */
export type OnboardingReadiness =
  | { kind: 'loading' }
  | { kind: 'adapter-absent' }
  | { kind: 'provider-ready' }
  | { kind: 'credential-missing' }
  | {
    kind: 'unavailable'
    reason:
      | 'load-failed'
      | 'provider-inactive'
      | 'credentials-unavailable'
      | 'settings-read-only'
      | 'credential-read-only'
  }

/**
 * Project first-run readiness from the provider/settings/credential join used
 * by the Models page. The step exists to leave the user with a model to talk
 * to, so ANY usable provider ends it; only when none exists does the official
 * DeepSeek route — the one route the prompt can offer a key field for — decide
 * whether prompting can help. A missing official configurable-provider
 * declaration means the adapter is not repairable by navigating to Models.
 * @param state - current shared Models join snapshot.
 * @returns the onboarding state without reading a parallel fact source.
 */
export function onboardingReadiness(state: ModelsSettingsState): OnboardingReadiness {
  if ((state.status === 'idle' || state.status === 'loading') && state.rows.length === 0) {
    return { kind: 'loading' }
  }
  if (state.status === 'error') {
    return {
      kind: 'unavailable',
      reason: 'load-failed',
    }
  }
  if (state.rows.some(providerUsable)) return { kind: 'provider-ready' }
  const row = state.rows.find(candidate =>
    candidate.entry.provider === 'deepseek-official'
    && candidate.entry.settingsNs === 'llm-deepseek'
    && candidate.entry.settingsPath.length === 0)
  if (row === undefined) return { kind: 'adapter-absent' }
  if (!row.entry.active) {
    return {
      kind: 'unavailable',
      reason: 'provider-inactive',
    }
  }
  // Past the usable gate an active route names a reference it has no stored
  // credential for, so the remaining questions are all about that credential.
  if (state.credentialError !== null || row.credential === undefined) {
    return {
      kind: 'unavailable',
      reason: 'credentials-unavailable',
    }
  }
  if (!state.writable) {
    return {
      kind: 'unavailable',
      reason: 'settings-read-only',
    }
  }
  if (!row.credential.writable) {
    return {
      kind: 'unavailable',
      reason: 'credential-read-only',
    }
  }
  return { kind: 'credential-missing' }
}
