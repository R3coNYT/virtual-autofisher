const DISCORD_TOKEN = /[\w-]{24,}\.[\w-]{6}\.[\w-]{27,}/g

export function maskSecrets(s: string): string {
  return s.replace(DISCORD_TOKEN, '***TOKEN***')
}
