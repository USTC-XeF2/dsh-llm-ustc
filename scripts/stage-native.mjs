import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

const [source, packageDirectory] = process.argv.slice(2)
if (source === undefined || packageDirectory === undefined) {
  throw new Error('usage: node scripts/stage-native.mjs <helper-binary> <package-directory>')
}
const binary = process.platform === 'win32' ? 'dsh-llm-ustc-helper.exe' : 'dsh-llm-ustc-helper'
const destination = `${packageDirectory}/bin/${binary}`
await mkdir(dirname(destination), { recursive: true })
await copyFile(source, destination)
if (process.platform !== 'win32') await chmod(destination, 0o755)
console.log(`staged ${basename(source)} -> ${destination}`)
