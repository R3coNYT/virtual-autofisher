import { describe, expect, it } from 'vitest'
import { classifyLoginError } from '../../src/main/discord/SelfbotClient'

describe('classifyLoginError', () => {
  it('maps auth rejections to invalidToken', () => {
    expect(classifyLoginError(Object.assign(new Error('x'), { code: 'TOKEN_INVALID' })).kind).toBe('invalidToken')
    expect(classifyLoginError(Object.assign(new Error('x'), { status: 401 })).kind).toBe('invalidToken')
    expect(classifyLoginError(new Error('An invalid token was provided.')).kind).toBe('invalidToken')
  })
  it('maps transport errors to network', () => {
    expect(classifyLoginError(new Error('getaddrinfo ENOTFOUND discord.com')).kind).toBe('network')
    expect(classifyLoginError('boom').message).toBe('Connexion à Discord impossible')
  })
})
