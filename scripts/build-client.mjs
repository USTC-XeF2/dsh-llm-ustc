import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const input = join(root, 'src', 'client', 'index.tsx')
const output = join(root, 'lib', 'client.js')
const bundle = await rolldown({
  input,
  external(id) {
    return id === 'react' || id.startsWith('react/') || id.startsWith('@deepseek-ai/')
  },
})
const generated = await bundle.generate({
  format: 'cjs',
  exports: 'named',
})
await bundle.close()
const chunk = generated.output.find(item => item.type === 'chunk')
if (chunk === undefined) throw new Error('client build did not emit a JavaScript chunk')
if (/^\s*(?:import|export)\s/mu.test(chunk.code)) {
  throw new Error('client build contains top-level ESM syntax; DSH client bundles must execute as classic scripts')
}
const wrapped = [
  'window.__ModuleLoader__.load({',
  '  id: "dsh-llm-ustc",',
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  chunk.code,
  '    return module.exports;',
  '  },',
  '});',
  '',
].join('\n')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, wrapped)
