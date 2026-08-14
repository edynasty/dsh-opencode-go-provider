import { spawnSync } from 'node:child_process'

const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
})
if (result.status !== 0) {
  process.stderr.write(result.stderr)
  process.exit(result.status ?? 1)
}

const [manifest] = JSON.parse(result.stdout)
const names = manifest.files.map(file => file.path)
const required = [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'README.md',
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/index.d.ts',
  'lib/client.js',
  'lib/client.d.ts',
  'catalog/models.json',
  'catalog/patches.json',
  'catalog/deprecated.json',
  'catalog/quarantine.json',
]
for (const name of required) {
  if (!names.includes(name)) throw new Error(`packed artifact is missing ${name}`)
}

const forbidden = names.filter(name =>
  /(^|\/)(?:\.env(?:\.|$)|\.git|node_modules|tests?|scripts?|src|fixtures)(?:\/|$)|auth\.json$|credential|token|synthetic-unknown-live-probe/iu.test(name),
)
if (forbidden.length > 0) {
  throw new Error(`packed artifact contains forbidden files: ${forbidden.join(', ')}`)
}

process.stdout.write(`validated ${names.length} packed files (${manifest.size} bytes, ${manifest.unpackedSize} unpacked bytes)\n`)
