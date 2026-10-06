import { describe, expect, it } from 'vitest'
import type { AuthStatus } from '../../src/shared/ipc'
import { resolveFirstScreen } from '../../src/renderer/resolveFirstScreen'

const user = { id: '1', username: 'u', avatarUrl: '' }
const target = { guildId: '1', channelId: '2' }
const base: AuthStatus = { user: null, target: null, hasToken: false, connection: null }

describe('resolveFirstScreen', () => {
  it('no token -> onboarding', () => {
    expect(resolveFirstScreen(base)).toEqual({ screen: 'onboarding' })
  })
  it('token + no event yet -> splash', () => {
    expect(resolveFirstScreen({ ...base, hasToken: true })).toEqual({ screen: 'splash', message: undefined })
  })
  it('token + connecting -> splash', () => {
    expect(resolveFirstScreen({ ...base, hasToken: true, connection: { status: 'connecting' } }).screen).toBe('splash')
  })
  it('token + network disconnected -> splash with message', () => {
    const connection = { status: 'disconnected' as const, message: 'Connexion à Discord impossible' }
    expect(resolveFirstScreen({ ...base, hasToken: true, connection })).toEqual({
      screen: 'splash',
      message: 'Connexion à Discord impossible'
    })
  })
  it('invalidToken -> onboarding with error', () => {
    expect(resolveFirstScreen({ ...base, connection: { status: 'invalidToken' } })).toEqual({
      screen: 'onboarding',
      error: 'Token invalide ou expiré'
    })
  })
  it('user + target -> dashboard; user without target -> picker', () => {
    expect(resolveFirstScreen({ ...base, user, target, hasToken: true }).screen).toBe('dashboard')
    expect(resolveFirstScreen({ ...base, user, hasToken: true }).screen).toBe('picker')
  })
})
