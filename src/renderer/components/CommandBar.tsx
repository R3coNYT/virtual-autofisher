import { memo, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { Send } from 'lucide-react'
import type { EngineState, SlashCommandInfo } from '../../shared/types'
import { coinflipOptionNames, parseCommandLine, sellAllOptions } from '../format'
import { useStore } from '../store'
import { cleanError, focusRing } from '../ui'
import { cardCls } from './StatCard'

const ACTIVE: EngineState[] = ['running', 'paused', 'resting']

type Quick = { label: string; name: string; options?: (cmd: SlashCommandInfo) => Record<string, string | number> }
const QUICK: Quick[] = [
  { label: '/sell all', name: 'sell', options: sellAllOptions },
  { label: '/daily', name: 'daily' },
  { label: '/quests', name: 'quests' },
  { label: '/boosts', name: 'boosts' },
  { label: '/profile', name: 'profile' },
  { label: '/top', name: 'top' }
]

const btn = `rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/5 ${focusRing}`
const field = `rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 disabled:opacity-40 ${focusRing}`

export const CommandBar = memo(function CommandBar(): JSX.Element {
  const commands = useStore((s) => s.commands)
  const engineState = useStore((s) => s.engineState)
  const [side, setSide] = useState('')
  const [amount, setAmount] = useState('')
  const [line, setLine] = useState('')
  const listId = useId()

  const captcha = engineState === 'captcha'
  const locked = captcha || !ACTIVE.includes(engineState)
  const lockReason = captcha ? 'Solve the captcha first' : 'Start fishing to send commands'
  const find = (name: string): SlashCommandInfo | undefined => commands.find((c) => c.name === name)
  const reasonFor = (name: string): string | undefined =>
    locked ? lockReason : find(name) ? undefined : `/${name} unavailable on this server`

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
        const reason = reasonFor(q.name)
        return (
          <button
            key={q.name}
            type="button"
            className={btn}
            disabled={!!reason}
            title={reason ?? `Send ${q.label}`}
            onClick={() => cmd && send(q.name, q.options?.(cmd))}
          >
            {q.label}
          </button>
        )
      })}

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
          disabled={locked}
          title={locked ? lockReason : undefined}
          placeholder="/command option=value"
          aria-label="Free command"
          className={`${field} min-w-0 flex-1`}
        />
        <datalist id={listId}>
          {commands.map((c) => (
            <option key={c.name} value={`/${c.name} ${c.options.map((o) => `${o.name}=`).join(' ')}`.trim()} />
          ))}
        </datalist>
        <button type="submit" className={btn} disabled={locked || !line.trim()} aria-label="Send the command" title="Send">
          <Send className="h-3.5 w-3.5" aria-hidden />
        </button>
      </form>
    </section>
  )
})
