import type { AuthStatus } from '../shared/ipc'

export type FirstScreen =
  | { screen: 'onboarding'; error?: string }
  | { screen: 'splash'; message?: string }
  | { screen: 'picker' | 'dashboard' }

export const INVALID_TOKEN_MESSAGE = 'Token invalide ou expiré'

/**
 * Decides where to land from the auth state. Onboarding is only shown when there is no stored
 * token or main reported an invalid one; while a stored token is still logging in (or retrying
 * after a network error) we stay on the splash.
 */
export function resolveFirstScreen(status: AuthStatus, connection: AuthStatus['connection'] = status.connection): FirstScreen {
  if (connection?.status === 'invalidToken') return { screen: 'onboarding', error: INVALID_TOKEN_MESSAGE }
  if (status.user) return { screen: status.target ? 'dashboard' : 'picker' }
  if (!status.hasToken) return { screen: 'onboarding' }
  return { screen: 'splash', message: connection?.status === 'disconnected' ? connection.message : undefined }
}
