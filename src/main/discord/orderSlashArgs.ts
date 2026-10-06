import type { SlashCommandInfo } from '../../shared/types'
import type { SlashOptions } from './DiscordClient'

export type SlashArg = string | number | boolean | undefined

/**
 * The lib assigns positional args strictly by option index, so unset options
 * before a provided one stay as `undefined` gaps; trailing unset ones are trimmed.
 */
export function orderSlashArgs(info: SlashCommandInfo, options: SlashOptions): SlashArg[] {
  const names = info.options.map((o) => o.name)
  for (const name of Object.keys(options)) {
    if (!names.includes(name)) throw new Error(`Option inconnue : ${name}`)
  }
  let last = -1
  names.forEach((n, i) => {
    if (options[n] !== undefined) last = i
  })
  return names.slice(0, last + 1).map((n) => options[n])
}
