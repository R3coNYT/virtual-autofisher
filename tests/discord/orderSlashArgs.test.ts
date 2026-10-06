import { describe, expect, it } from 'vitest'
import { orderSlashArgs } from '../../src/main/discord/orderSlashArgs'

const info = {
  name: 'buy',
  id: '1',
  version: '1',
  options: ['item', 'amount', 'note'].map((name) => ({ name, type: 3, required: false }))
}

describe('orderSlashArgs', () => {
  it('keeps a gap before a provided option', () => {
    expect(orderSlashArgs(info, { amount: 5 })).toEqual([undefined, 5])
  })
  it('trims trailing unset options', () => {
    expect(orderSlashArgs(info, { item: 'rod' })).toEqual(['rod'])
    expect(orderSlashArgs(info, {})).toEqual([])
  })
  it('orders by command options, not by input order', () => {
    expect(orderSlashArgs(info, { note: 'x', item: 'a' })).toEqual(['a', undefined, 'x'])
  })
  it('throws on an unknown option', () => {
    expect(() => orderSlashArgs(info, { bogus: 1 })).toThrow('Option inconnue : bogus')
  })
})
