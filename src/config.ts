import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { API_KEY_REF } from './constants.ts'

export interface Config {
  apiKeyEnv: Volatile<string>
  selectedServerId: Volatile<string | undefined>
  directRecoverySeconds: Volatile<number>
}

export const Config = z.object({
  apiKeyEnv: z.union([API_KEY_REF]).role('credential-ref').default(API_KEY_REF).volatile(),
  selectedServerId: z.string().volatile(),
  directRecoverySeconds: z.number().step(1).min(30).max(86_400).default(300).volatile(),
})

export interface ResolvedConfig {
  selectedServerId?: string
  directRecoverySeconds: number
}

export function resolveConfig(config: Config): ResolvedConfig {
  const directRecoverySeconds = config.directRecoverySeconds.get()
  if (!Number.isSafeInteger(directRecoverySeconds) || directRecoverySeconds < 30 || directRecoverySeconds > 86_400) {
    throw new TypeError('llm-ustc.directRecoverySeconds must be an integer from 30 to 86400')
  }
  const selected = config.selectedServerId.get()?.trim()
  return {
    ...(selected === undefined || selected.length === 0 ? {} : { selectedServerId: selected }),
    directRecoverySeconds,
  }
}
