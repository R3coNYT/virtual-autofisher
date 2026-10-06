export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

export type CatchItem = { name: string; count: number }
export type RareCounts = { gold: number; emerald: number; lava: number; diamond: number }

export type EngineState = 'idle' | 'connecting' | 'running' | 'paused' | 'resting' | 'captcha' | 'error'
export type PauseReason = 'user' | 'network' | 'noResponse' | 'exception'

export type SelfUser = { id: string; username: string; avatarUrl: string }
export type GuildInfo = { id: string; name: string; iconUrl: string | null; hasVirtualFisher: boolean }
export type ChannelInfo = { id: string; name: string; parentName: string | null }

export type SlashCommandInfo = {
  name: string
  id: string
  version: string
  options: { name: string; type: number; required: boolean; choices?: string[] }[]
}

export type BotMessage = {
  id: string
  channelId: string
  content: string
  embeds: {
    title?: string
    description?: string
    fields: { name: string; value: string }[]
    imageUrl?: string
    footer?: string
  }[]
  ephemeral: boolean
  isEdit: boolean
  interactionUserId?: string
}

export type GameEvent =
  | { kind: 'catch'; items: CatchItem[]; xp?: number; levelUp?: number; treasure?: string[]; raw: string }
  | { kind: 'sell'; earned: number; xp?: number }
  | {
      kind: 'inventory'
      balance: number
      level: number
      xpToNext?: number
      rod?: string
      biome?: string
      bait?: { name: string; count: number }
      rare: { gold: number; emerald: number; lava: number; diamond: number }
    }
  | {
      kind: 'stats'
      crates?: number
      quests?: number
      trips?: number
      dailyStreak?: number
      totals: Partial<RareCounts>
    }
  | { kind: 'boosts'; active: { name: string; endsAt: number }[] }
  | { kind: 'purchase'; item: string; amount: number; cost?: number }
  | { kind: 'daily'; reward: string }
  | { kind: 'quests'; quests: { label: string; progress: string; done: boolean }[] }
  | { kind: 'cooldown'; waitMs: number }
  | { kind: 'captcha'; imageUrl?: string; text: string }
  | { kind: 'captchaSolved' }
  | { kind: 'captchaFailed'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'unknown'; title?: string; text: string }

export type LogEntry = {
  id: number
  at: number
  type: 'catch' | 'trade' | 'system' | 'error' | 'unknown'
  text: string
  highlight?: boolean
}

export type GameSnapshot = {
  account: {
    balance: number | null
    level: number | null
    xpToNext: number | null
    rod: string | null
    biome: string | null
    bait: { name: string; count: number } | null
    rare: RareCounts
    totals: Partial<RareCounts> & { crates?: number; quests?: number; trips?: number; dailyStreak?: number }
  }
  boosts: { name: string; endsAt: number }[]
  quests: { label: string; progress: string; done: boolean }[]
  session: {
    startedAt: number | null
    catches: number
    fishBySpecies: Record<string, number>
    moneyEarned: number
    xpEarned: number
    sells: number
    captchas: number
    commandsSent: number
    rareCaught: RareCounts
  }
  nextFishAt: number | null
  nextDailyAt: number | null
  log: LogEntry[]
}

export type SessionSummary = GameSnapshot['session'] & { endedAt: number }

export type Config = {
  version: number
  tokenEncrypted?: string
  target: { guildId: string; channelId: string } | null
  fishing: { baseCooldownSec: number; jitterSec: number; minGapSec: number }
  sell: { enabled: boolean; mode: 'catches' | 'minutes'; every: number }
  buffs: { enabled: boolean; lengthMin: 5 | 20 }
  bait: { enabled: boolean; name: string; autoAmount: boolean; amount: number }
  profile: { refreshMin: number }
  daily: { enabled: boolean }
  quests: { enabled: boolean }
  breaks: { enabled: boolean; workMin: number; workJitterMin: number; restMin: number; restJitterMin: number }
  sessionLimitH: number
  notifications: { captcha: boolean; sound: boolean; levelUp: boolean; rareFish: boolean }
  ui: { compactLog: boolean }
  capture: boolean
}

export const DEFAULT_CONFIG: Config = {
  version: 1,
  target: null,
  fishing: { baseCooldownSec: 3.5, jitterSec: 0.8, minGapSec: 2.5 },
  sell: { enabled: true, mode: 'catches', every: 25 },
  buffs: { enabled: false, lengthMin: 5 },
  bait: { enabled: false, name: '', autoAmount: true, amount: 0 },
  profile: { refreshMin: 5 },
  daily: { enabled: true },
  quests: { enabled: true },
  breaks: { enabled: false, workMin: 45, workJitterMin: 10, restMin: 5, restJitterMin: 2 },
  sessionLimitH: 0,
  notifications: { captcha: true, sound: true, levelUp: true, rareFish: true },
  ui: { compactLog: false },
  capture: false
}
