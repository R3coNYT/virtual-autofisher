import type { Rule } from '../text'

const ERROR =
  /don'?t have enough|not enough|insufficient|unknown (?:item|command|bait|rod)|invalid (?:item|amount|command)|doesn'?t exist|you (?:can'?t|cannot)/i

export const errorRule: Rule = (_m, text) => (ERROR.test(text) ? { kind: 'error', text } : null)
