import { describe, expect, it } from 'vitest'
import { choiceFields, choiceCommandOptions } from '../../src/renderer/format'
import type { SlashCommandInfo } from '../../src/shared/types'

const TOP: SlashCommandInfo = {
  name: 'top',
  id: '1',
  version: '1',
  options: [
    {
      name: 'category',
      type: 3,
      required: true,
      choices: ['xp', 'money', 'net'],
      choiceNames: ['XP', 'Money', 'Net Worth']
    },
    { name: 'scope', type: 3, required: false, choices: ['global', 'server'] },
    { name: 'page', type: 4, required: false }
  ]
}

describe('choice commands (/top)', () => {
  it('lists one field per option that has choices, with display labels', () => {
    expect(choiceFields(TOP)).toEqual([
      {
        name: 'category',
        required: true,
        choices: [
          { value: 'xp', label: 'XP' },
          { value: 'money', label: 'Money' },
          { value: 'net', label: 'Net Worth' }
        ]
      },
      {
        name: 'scope',
        required: false,
        choices: [
          { value: 'global', label: 'Global' },
          { value: 'server', label: 'Server' }
        ]
      }
    ])
  })

  it('builds options: required defaults to its first choice, optional omitted when empty', () => {
    expect(choiceCommandOptions(TOP, {})).toEqual({ category: 'xp' })
    expect(choiceCommandOptions(TOP, { category: 'net', scope: '' })).toEqual({ category: 'net' })
    expect(choiceCommandOptions(TOP, { category: 'money', scope: 'server' })).toEqual({ category: 'money', scope: 'server' })
  })

  it('ignores values that are not valid choices', () => {
    expect(choiceCommandOptions(TOP, { category: 'bogus', scope: 'nope' })).toEqual({ category: 'xp' })
  })
})
