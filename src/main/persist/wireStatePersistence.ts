import type { SessionSummary } from '../../shared/types'
import type { GameState } from '../engine/GameState'
import type { Logger } from '../util/logger'
import type { StateStore } from './StateStore'

type Deps = {
  state: GameState
  engine: { onSessionEnd(cb: (s: SessionSummary) => void): () => void }
  store: Pick<StateStore, 'load' | 'save'>
  logger: Logger
}

/**
 * Loads state.json into GameState (last known account values and next daily, shown before
 * login) and saves it at the end of every session and whenever nextDailyAt changes.
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
  engine.onSessionEnd(save)
  state.onPatch((patch) => {
    if ('nextDailyAt' in patch) save()
  })
  return { save }
}
