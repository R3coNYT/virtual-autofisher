import { safeStorage } from 'electron'
import type { Cipher } from './ConfigStore'

export const safeStorageCipher: Cipher = {
  encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
  decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  available: () => safeStorage.isEncryptionAvailable()
}
