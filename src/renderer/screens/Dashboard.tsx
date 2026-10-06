import { Background } from '../components/Background'
import { BoostChips } from '../components/BoostChips'
import { CatchLog } from '../components/CatchLog'
import { CommandBar } from '../components/CommandBar'
import { CooldownRing } from '../components/CooldownRing'
import { RareFishGrid } from '../components/RareFishGrid'
import { SidePanel } from '../components/SidePanel'
import { StatCard } from '../components/StatCard'
import { TopBar } from '../components/TopBar'
import { catchesPerHour, formatInt, formatMoney } from '../format'
import { useStore } from '../store'
import { useNow } from '../useNow'

function signed(n: number): string {
  return `${n >= 0 ? '+' : '−'}${formatMoney(Math.abs(n))}`
}

function RateCard({ catches, startedAt }: { catches: number; startedAt: number | null }): JSX.Element {
  const now = useNow()
  const rate = catchesPerHour(catches, startedAt, now)
  return <StatCard label="Catches" value={formatInt(catches)} sub={rate != null ? `${formatInt(rate)} / h` : '— / h'} />
}

export default function Dashboard(): JSX.Element {
  const account = useStore((s) => s.game.account)
  const session = useStore((s) => s.game.session)
  const nextFishAt = useStore((s) => s.game.nextFishAt)
  const nextDailyAt = useStore((s) => s.game.nextDailyAt)
  const boosts = useStore((s) => s.game.boosts)
  const quests = useStore((s) => s.game.quests)
  const log = useStore((s) => s.log)
  const compact = useStore((s) => s.config.ui.compactLog)
  const baseCooldownSec = useStore((s) => s.config.fishing.baseCooldownSec)
  const sessionMoney = `${signed(session.moneyEarned)} this session`

  return (
    <Background>
      {/* exactly the window height: only the journal (and the side panel) scroll, the page never grows */}
      <div className="flex h-screen flex-col overflow-hidden">
        <TopBar />
        <main className="flex min-h-0 flex-1 flex-col gap-3 p-5">
          <div className="grid shrink-0 grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard
              label="Balance"
              value={formatMoney(account.balance)}
              sub={account.fishValue != null ? `Fish: ${formatMoney(account.fishValue)}` : sessionMoney}
            >
              {account.fishValue != null && <p className="mt-0.5 truncate text-xs text-slate-400">{sessionMoney}</p>}
            </StatCard>
            <StatCard
              label="Level"
              value={account.level ?? '—'}
              sub={
                account.xpToNext != null
                  ? `${formatInt(account.xpToNext)} XP to level ${(account.level ?? 0) + 1}`
                  : undefined
              }
            />
            <RateCard catches={session.catches} startedAt={session.startedAt} />
            <StatCard
              label="Next /fish"
              aside={<CooldownRing nextFishAt={nextFishAt} fallbackMs={baseCooldownSec * 1000} />}
            />
          </div>
          <div className="shrink-0">
            <BoostChips boosts={boosts} />
          </div>
          <div className="shrink-0">
            <RareFishGrid session={session.rareCaught} total={account.rare} />
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] gap-3 md:grid-cols-[minmax(0,1fr)_17rem]">
            <CatchLog log={log} compact={compact} />
            <SidePanel account={account} quests={quests} nextDailyAt={nextDailyAt} />
          </div>
          <div className="shrink-0">
            <CommandBar />
          </div>
        </main>
      </div>
    </Background>
  )
}
