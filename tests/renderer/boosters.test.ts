import { describe, expect, it } from 'vitest'
import { boosterUseOptions } from '../../src/shared/boosters'
import type { SlashCommandInfo } from '../../src/shared/types'

const use = (choices?: string[], name = 'type'): SlashCommandInfo => ({
  name: 'use',
  id: '1',
  version: '1',
  options: [{ name, type: 3, required: true, choices }]
})

describe('boosterUseOptions', () => {
  it('maps the kind to the real option name and choice value, case-insensitively', () => {
    expect(boosterUseOptions(use(['Personal', 'Global']), 'personal')).toEqual({ type: 'Personal' })
    expect(boosterUseOptions(use(['personal', 'global'], 'kind'), 'global')).toEqual({ kind: 'global' })
  })
  it('null when the command or the choice is missing', () => {
    expect(boosterUseOptions(undefined, 'personal')).toBeNull()
    expect(boosterUseOptions(use(['Global']), 'personal')).toBeNull()
    expect(boosterUseOptions(use(undefined), 'personal')).toBeNull()
  })
})
