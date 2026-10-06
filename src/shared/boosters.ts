import type { SlashCommandInfo } from './types'

/**
 * Options for `/use` activating a booster of `kind`: the option whose choices contain it
 * (case-insensitive, the real choice value is sent). Null when the command or the choice is missing.
 */
export function boosterUseOptions(cmd: SlashCommandInfo | undefined, kind: 'personal' | 'global'): Record<string, string> | null {
  for (const o of cmd?.options ?? []) {
    const choices = o.choices ?? []
    const choice = choices.find((c) => c.toLowerCase() === kind) ?? choices.find((c) => c.toLowerCase().includes(kind))
    if (choice) return { [o.name]: choice }
  }
  return null
}
