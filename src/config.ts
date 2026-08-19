import z from '@deepseek-ai/schemastery'

export interface Config {
  selectedServerId?: string
  directRecoverySeconds?: number
}

export const Config: z<Config> = z.object({
  selectedServerId: z.string(),
  directRecoverySeconds: z.number().step(1).min(30).max(86_400).default(300),
})

export interface ResolvedConfig {
  selectedServerId?: string
  directRecoverySeconds: number
}

export function resolveConfig(config: Config): ResolvedConfig {
  const directRecoverySeconds = config.directRecoverySeconds ?? 300
  if (!Number.isSafeInteger(directRecoverySeconds) || directRecoverySeconds < 30 || directRecoverySeconds > 86_400) {
    throw new TypeError('llm-ustc.directRecoverySeconds must be an integer from 30 to 86400')
  }
  const selected = config.selectedServerId?.trim()
  return {
    ...(selected === undefined || selected.length === 0 ? {} : { selectedServerId: selected }),
    directRecoverySeconds,
  }
}
