import z from '@deepseek-ai/schemastery'

export interface Config {
  selectedServerId?: string
  directReprobeSeconds?: number
}

export const Config: z<Config> = z.object({
  selectedServerId: z.string(),
  directReprobeSeconds: z.number().step(1).min(30).max(86_400).default(300),
})

export interface ResolvedConfig {
  selectedServerId?: string
  directReprobeSeconds: number
}

export function resolveConfig(config: Config): ResolvedConfig {
  const directReprobeSeconds = config.directReprobeSeconds ?? 300
  if (!Number.isSafeInteger(directReprobeSeconds) || directReprobeSeconds < 30 || directReprobeSeconds > 86_400) {
    throw new TypeError('llm-ustc.directReprobeSeconds must be an integer from 30 to 86400')
  }
  const selected = config.selectedServerId?.trim()
  return {
    ...(selected === undefined || selected.length === 0 ? {} : { selectedServerId: selected }),
    directReprobeSeconds,
  }
}
