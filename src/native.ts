import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface NativeTarget {
  packageName: string
  binaryName: string
}

const TARGETS: Record<string, NativeTarget> = {
  'win32-x64': { packageName: '@dsh-llm-ustc/helper-win32-x64', binaryName: 'dsh-llm-ustc-helper.exe' },
  'win32-arm64': { packageName: '@dsh-llm-ustc/helper-win32-arm64', binaryName: 'dsh-llm-ustc-helper.exe' },
  'darwin-x64': { packageName: '@dsh-llm-ustc/helper-darwin-x64', binaryName: 'dsh-llm-ustc-helper' },
  'darwin-arm64': { packageName: '@dsh-llm-ustc/helper-darwin-arm64', binaryName: 'dsh-llm-ustc-helper' },
  'linux-x64': { packageName: '@dsh-llm-ustc/helper-linux-x64', binaryName: 'dsh-llm-ustc-helper' },
  'linux-arm64': { packageName: '@dsh-llm-ustc/helper-linux-arm64', binaryName: 'dsh-llm-ustc-helper' },
}

export function nativeTarget(platform = process.platform, arch = process.arch): NativeTarget {
  const target = TARGETS[`${platform}-${arch}`]
  if (target === undefined) throw new Error(`dsh-llm-ustc does not provide a helper for ${platform}/${arch}`)
  return target
}

export async function resolveHelperBinary(): Promise<string> {
  const target = nativeTarget()
  const development = [
    join(root, 'helper', 'target', 'debug', target.binaryName),
    join(root, 'helper', 'target', 'release', target.binaryName),
    join(root, 'target', 'debug', target.binaryName),
    join(root, 'target', 'release', target.binaryName),
  ]
  for (const candidate of development) {
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return candidate
    } catch {}
  }
  try {
    const manifest = require.resolve(`${target.packageName}/package.json`)
    const binary = join(dirname(manifest), 'bin', target.binaryName)
    await access(binary, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return binary
  } catch (error) {
    throw new Error(`native helper ${target.packageName} is not installed for ${process.platform}/${process.arch}`, { cause: error })
  }
}
