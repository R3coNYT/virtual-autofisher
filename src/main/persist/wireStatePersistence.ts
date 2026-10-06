import type { SessionSummary } from '../../shared/types'
import type { GameState } from '../engine/GameState'
import type { Logger } from '../util/logger'
import type { StateStore } from './StateStore'

const ACCOUNT_SAVE_DELAY_MS = 2000

type Deps = {
  state: GameState
  engine: { onSessionEnd(cb: (s: SessionSummary) => void): () => void }
  store: Pick<StateStore, 'load' | 'save'>
  logger: Logger
}

/**
 * Loads state.json into GameState (last known account values and next daily, shown before
 * login) and saves it at the end of every session, whenever nextDailyAt changes, and 2 s
 * after account values change (debounced).
 * The caller also calls save() on before-quit.
 */
export function wireStatePersistence({ state, engine, store, logger }: Deps): { save(): void } {
  try {
    const loaded = store.load()
    if (loaded) state.hydrate(loaded)
  } catch (e) {
    logger.error('Unable to load state.json', e)
  }
  const save = (): void => {
    try {
      store.save(state.persisted())
    } catch (e) {
      logger.error('Unable to save state.json', e)
    }
  }
  // Account values change on every /profile, also outside sessions (manual commands): write them
  // soon after (debounced), so a kill without before-quit (e.g. Ctrl+C on `npm run dev`) loses nothing.
  let pending: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (pending) clearTimeout(pending)
    pending = null
    save()
  }
  engine.onSessionEnd(flush)
  state.onPatch((patch) => {
    if ('nextDailyAt' in patch) flush()
    else if ('account' in patch && !pending) pending = setTimeout(flush, ACCOUNT_SAVE_DELAY_MS)
  })
  return { save: flush }
}
