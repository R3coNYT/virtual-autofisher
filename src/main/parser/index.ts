import type { BotMessage, GameEvent } from '../../shared/types'
import { buildText, titlesOf, type Rule } from './text'
import { captchaFailedRule, captchaRule, captchaSolvedRule } from './rules/captcha'
import { catchRule } from './rules/catch'
import { cooldownRule } from './rules/cooldown'
import { sellRule } from './rules/sell'
import { inventoryRule } from './rules/inventory'
import { statsRule } from './rules/stats'
import { makeBoostsRule } from './rules/boosts'
import { boostersRule } from './rules/boosters'
import { purchaseRule } from './rules/purchase'
import { dailyRule } from './rules/daily'
import { questsRule } from './rules/quests'
import { errorRule } from './rules/error'

export { cleanText, parseNumber, parseDuration } from './text'

/** Pure: turns a bot message into a typed GameEvent. Never throws. */
export function parseMessage(m: BotMessage, now: number = Date.now()): GameEvent {
  let text = ''
  try {
    text = buildText(m)
  } catch {
    /* fall through to unknown */
  }
  // Fixed order: captcha always first.
  const rules: Rule[] = [
    captchaRule,
    captchaSolvedRule,
    captchaFailedRule,
    cooldownRule,
    catchRule,
    sellRule,
    inventoryRule,
    statsRule,
    boostersRule, // before boosts: "Your Boosters" also matches /boost/
    makeBoostsRule(now),
    purchaseRule,
    dailyRule,
    questsRule,
    errorRule
  ]
  for (const rule of rules) {
    try {
      const ev = rule(m, text)
      if (ev) return ev
    } catch {
      /* a rule that throws is skipped */
    }
  }
  let title: string | undefined
  try {
    title = titlesOf(m)[0]
  } catch {
    title = undefined
  }
  return { kind: 'unknown', title, text }
}
