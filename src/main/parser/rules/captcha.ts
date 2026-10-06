import type { Rule } from '../text'

const CAPTCHA = /captcha|\/verify|\bverify\b/i
const SOLVED = /you may now continue/i
const FAILED = /incorrect|wrong code|invalid code/i

const isSolved = (t: string): boolean => SOLVED.test(t)
const isFailed = (t: string): boolean => FAILED.test(t) && CAPTCHA.test(t)

/** Deliberately broad: a false positive is preferred over a missed captcha. */
export const captchaRule: Rule = (m, text) => {
  if (isSolved(text) || isFailed(text) || !CAPTCHA.test(text)) return null
  const imageUrl = (m.embeds ?? []).find((e) => e.imageUrl)?.imageUrl
  return { kind: 'captcha', imageUrl, text }
}

export const captchaSolvedRule: Rule = (_m, text) => (isSolved(text) ? { kind: 'captchaSolved' } : null)

export const captchaFailedRule: Rule = (_m, text) => (isFailed(text) ? { kind: 'captchaFailed', text } : null)
