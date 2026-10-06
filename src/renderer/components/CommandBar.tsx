import { memo, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { Send } from 'lucide-react'
import { boosterUseOptions } from '../../shared/boosters'
import type { SlashCommandInfo } from '../../shared/types'
import {
  choiceCommandOptions,
  choiceFields,
  coinflipOptionNames,
  commandLockReason,
  parseCommandLine,
  sellAllOptions
} from '../format'
import { useStore } from '../store'
import { cleanError, focusRing } from '../ui'
import { cardCls } from './StatCard'

const UNAVAILABLE = 'Command unavailable'

/** `options` returning null: the command exists but lacks the needed choice (button disabled). */
type Quick = {
  label: string
  name: string
  options?: (cmd: SlashCommandInfo) => Record<string, string | number> | null
  missingChoice?: string
}
const QUICK: Quick[] = [
  { label: '/sell all', name: 'sell', options: sellAllOptions },
  { label: '/daily', name: 'daily' },
  { label: '/quests', name: 'quests' },
  { label: '/boosts', name: 'boosts' },
  { label: '/boosters', name: 'boosters' },
  { label: '/use Personal', name: 'use', options: (c) => boosterUseOptions(c, 'personal'), missingChoice: 'Personal' },
  { label: '/use Global', name: 'use', options: (c) => boosterUseOptions(c, 'global'), missingChoice: 'Global' },
  { label: '/profile', name: 'profile' }
]

/** Commands sent with a pick for each of their choice options (e.g. /top category). */
const CHOICE_COMMANDS = ['top']

const btn = `rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/5 ${focusRing}`
const field = `rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 disabled:opacity-40 ${focusRing}`

/** A command with one select per choice option (optional ones start empty), plus its send button. */
function ChoiceCommand(props: {
  name: string
  cmd: SlashCommandInfo | undefined
  reason: string | undefined
  onSend: (name: string, options: Record<string, string>) => void
}): JSX.Element {
  const { name, cmd, reason, onSend } = props
  const [picked, setPicked] = useState<Record<string, string>>({})
  const fields = cmd ? choiceFields(cmd) : []
  const values = cmd ? choiceCommandOptions(cmd, picked) : {}
  return (
    <div className="flex items-center gap-1.5 border-l border-white/10 pl-2" role="group" aria-label={`/${name}`}>
      {fields.map((f) => (
        <select
          key={f.name}
          aria-label={`/${name} ${f.name}`}
          title={f.name}
          value={values[f.name] ?? ''}
          onChange={(e) => setPicked((p) => ({ ...p, [f.name]: e.target.value }))}
          disabled={!!reason}
          className={field}
        >
          {!f.required && (
            <option value="" className="bg-ocean">
              {f.name}: any
            </option>
          )}
          {f.choices.map((c) => (
            <option key={c.value} value={c.value} className="bg-ocean">
              {c.label}
            </option>
          ))}
        </select>
      ))}
      <button
        type="button"
        className={btn}
        disabled={!!reason}
        title={reason ?? `Send /${name}`}
        onClick={() => cmd && onSend(name, values)}
      >
        /{name}
      </button>
    </div>
  )
}

export const CommandBar = memo(function CommandBar(): JSX.Element {
  const commands = useStore((s) => s.commands)
  const engineState = useStore((s) => s.engineState)
  const hasTarget = useStore((s) => s.target !== null)
  const [side, setSide] = useState('')
  const [amount, setAmount] = useState('')
  const [line, setLine] = useState('')
  const listId = useId()

  const lockReason = commandLockReason(engineState, hasTarget)
  const find = (name: string): SlashCommandInfo | undefined => commands.find((c) => c.name === name)
  const reasonFor = (name: string): string | undefined => lockReason ?? (find(name) ? undefined : UNAVAILABLE)
  const lineReason = lockReason ?? (commands.length ? undefined : UNAVAILABLE)

  const fail = (e: unknown): void => useStore.getState().pushToast({ level: 'error', message: cleanError(e) })
  const send = (name: string, options?: Record<string, string | number>): void => {
    window.api.command.send(name, options).catch(fail)
  }

  const flip = coinflipOptionNames(find('coinflip'))
  const sides = flip.choices?.length ? flip.choices : ['heads', 'tails']
  const sideValue = sides.includes(side) ? side : sides[0]
  const amountNum = Number(amount)
  const flipReason = reasonFor('coinflip')
  const flipValid = amount.trim() !== '' && Number.isFinite(amountNum) && amountNum > 0

  function submitLine(e: FormEvent): void {
    e.preventDefault()
    const parsed = parseCommandLine(line, commands)
    if (!parsed.ok) return useStore.getState().pushToast({ level: 'error', message: parsed.error })
    send(parsed.name, parsed.options)
    setLine('')
  }

  return (
    <section className={`${cardCls} flex flex-wrap items-center gap-2 p-3`} aria-label="Quick commands">
      {QUICK.map((q) => {
        const cmd = find(q.name)
        const options = cmd && q.options ? q.options(cmd) : undefined
        const reason =
          reasonFor(q.name) ?? (options === null ? `/${q.name} has no "${q.missingChoice}" choice on this server` : undefined)
        return (
          <button
            key={q.label}
            type="button"
            className={btn}
            disabled={!!reason}
            title={reason ?? `Send ${q.label}`}
            onClick={() => cmd && options !== null && send(q.name, options)}
          >
            {q.label}
          </button>
        )
      })}

      {CHOICE_COMMANDS.map((name) => (
        <ChoiceCommand key={name} name={name} cmd={find(name)} reason={reasonFor(name)} onSend={send} />
      ))}

      <div className="flex items-center gap-1.5 border-l border-white/10 pl-2" role="group" aria-label="Coinflip">
        <select
          aria-label="Coinflip side"
          value={sideValue}
          onChange={(e) => setSide(e.target.value)}
          disabled={!!flipReason}
          className={field}
        >
          {sides.map((s) => (
            <option key={s} value={s} className="bg-ocean">
              {flip.choices?.length ? s.charAt(0).toUpperCase() + s.slice(1) : s === 'heads' ? 'Heads' : 'Tails'}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          inputMode="numeric"
          placeholder="Amount"
          aria-label="Coinflip amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={!!flipReason}
          className={`${field} w-24`}
        />
        <button
          type="button"
          className={btn}
          disabled={!!flipReason || !flipValid}
          title={flipReason ?? (flipValid ? 'Send /coinflip' : 'Enter an amount')}
          onClick={() => send('coinflip', { [flip.side]: sideValue, [flip.amount]: amountNum })}
        >
          /coinflip
        </button>
      </div>

      <form onSubmit={submitLine} className="ml-auto flex min-w-[14rem] flex-1 items-center gap-1.5">
        <input
          list={listId}
          value={line}
          onChange={(e) => setLine(e.target.value)}
          disabled={!!lineReason}
          title={lineReason}
          placeholder="/command option=value"
          aria-label="Free command"
          className={`${field} min-w-0 flex-1`}
        />
        <datalist id={listId}>
          {commands.map((c) => (
            <option key={c.name} value={`/${c.name} ${c.options.map((o) => `${o.name}=`).join(' ')}`.trim()} />
          ))}
        </datalist>
        <button type="submit" className={btn} disabled={!!lineReason || !line.trim()} aria-label="Send the command" title={lineReason ?? 'Send'}>
          <Send className="h-3.5 w-3.5" aria-hidden />
        </button>
      </form>
    </section>
  )
})
