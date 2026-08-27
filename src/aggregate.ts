// O agregador (design §6). Lê sources/*.json, varre cada fonte via GitHub API/raw, aplica
// adapter → gate de licença → dedup, materializa arquivos em <type>s/<id>/, calcula sha256,
// escreve index.json + ATTRIBUTION.md + report.json.
//
// Idempotente e resiliente: uma fonte que falhar (rate-limit exaurido, repo indisponível)
// não derruba o run — o agregador loga o problema, MANTÉM os itens dessa fonte que já
// existiam no index.json anterior (se houver) e segue com as demais fontes (design risco
// #6). Só sobrescreve o índice antigo se pelo menos uma fonte produziu itens (nunca escreve
// um index.json vazio por cima de um bom).

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRef, getRepoLicenseSpdx, GitHubError } from './github.js'
import { resolveLicense } from './license.js'
import { discoverSkillCandidates } from './adapters/skillmd.js'
import { discoverAgentCandidates } from './adapters/agentmd.js'
import { discoverHookCandidates } from './adapters/hookjson.js'
import { discoverMcpCandidates } from './adapters/mcpServer.js'
import { slug, sha256Hex, truncate } from './util.js'
import type { CatalogIndex, CatalogItem, RawCandidate, SourceConfig } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SOURCES_DIR = join(ROOT, 'sources')
const INDEX_PATH = join(ROOT, 'index.json')
const ATTRIBUTION_PATH = join(ROOT, 'ATTRIBUTION.md')
const REPORT_PATH = join(ROOT, 'report.json')

// ordem = prioridade em caso de dedup entre fontes (design §6 passo DEDUP) — fonte de cima
// vence. Um único `--only <id>` (argv) roda uma fonte só (design §6 "incremental-friendly").
const SOURCE_ORDER = [
  'anthropics-skills',
  'obra-superpowers',
  'voltagent-subagents',
  '0xfurai-subagents',
  'karanb192-hooks',
  'dwarvesf-guardrails',
  'mcp-registry',
  'hol-guard',
]

interface NeedsReviewEntry { source: string; name: string; reason: string }
interface DuplicateEntry { source: string; name: string; keptId: string }

function loadSourceConfigs(only?: string): SourceConfig[] {
  const configs: SourceConfig[] = []
  for (const id of SOURCE_ORDER) {
    const path = join(SOURCES_DIR, `${id}.json`)
    if (!existsSync(path)) continue
    if (only && only !== id) continue
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as SourceConfig
    configs.push(cfg)
  }
  return configs
}

function loadPreviousIndex(): CatalogIndex | null {
  if (!existsSync(INDEX_PATH)) return null
  try {
    return JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as CatalogIndex
  } catch {
    return null
  }
}

async function discoverForSource(source: SourceConfig, sha: string): Promise<RawCandidate[]> {
  switch (source.adapter) {
    case 'skillmd':
      return discoverSkillCandidates(source, sha)
    case 'agentmd':
      return discoverAgentCandidates(source, sha)
    case 'hookjson':
      return discoverHookCandidates(source, sha)
    case 'mcpServer':
      // sem UM repo upstream (agrega servidores de repos diferentes) — sha não se aplica,
      // a licença é resolvida por item dentro do próprio adapter (ver mcpServer.ts).
      return discoverMcpCandidates(source)
  }
}

function writeMaterializedFiles(dir: string, files: { rel: string; content: Buffer }[]): Record<string, string> {
  const sha256: Record<string, string> = {}
  const absDir = join(ROOT, dir)
  mkdirSync(absDir, { recursive: true })
  for (const f of files) {
    const dest = join(absDir, f.rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, f.content)
    sha256[f.rel] = sha256Hex(f.content)
  }
  return sha256
}

async function main(): Promise<void> {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined
  const sources = loadSourceConfigs(only)
  const previous = loadPreviousIndex()

  const items: CatalogItem[] = []
  const needsReview: NeedsReviewEntry[] = []
  const duplicates: DuplicateEntry[] = []
  const counts: Record<string, number> = {}
  const seenBySlug = new Map<string, string>() // `${type}:${slug(name)}` -> id mantido

  for (const source of sources) {
    console.log(`\n[aggregate] fonte: ${source.id} (${source.adapter}, ${source.repo}@${source.ref})`)
    let sha: string
    let repoSpdx: string | null = null
    let candidates: RawCandidate[]
    try {
      if (source.adapter === 'mcpServer') {
        // agrega servidores de repos diferentes — não há um `source.repo` upstream único
        // pra resolver ref/licença aqui; a licença é resolvida POR ITEM dentro do adapter
        // (ver mcpServer.ts), então repoSpdx fica null e o gate central (resolveLicense)
        // usa candidate.licenseDeclared normalmente.
        sha = 'live'
        candidates = await discoverForSource(source, sha)
      } else {
        sha = await resolveRef(source.repo, source.ref)
        repoSpdx = source.mixedLicense ? null : await getRepoLicenseSpdx(source.repo)
        candidates = await discoverForSource(source, sha)
      }
    } catch (e) {
      const msg = e instanceof GitHubError ? `${e.message}` : String(e)
      console.warn(`[aggregate] fonte "${source.id}" falhou (${msg}) — mantendo itens anteriores desta fonte, se houver.`)
      const kept = (previous?.items ?? []).filter((it) => it.source?.registry === source.id)
      items.push(...kept)
      counts[source.id] = kept.length
      continue
    }

    let sourceCount = 0
    for (const candidate of candidates.slice(0, source.limit)) {
      if (candidate.skipReason) {
        needsReview.push({ source: source.id, name: candidate.name, reason: candidate.skipReason })
        continue
      }

      const resolution = resolveLicense({
        itemDeclared: candidate.licenseDeclared,
        licenseFileText: candidate.licenseFileText,
        repoSpdx,
        mixedLicense: !!source.mixedLicense,
      })
      if (!resolution.allowed || !resolution.license) {
        needsReview.push({
          source: source.id,
          name: candidate.name,
          reason: `licença não permissiva/ausente (origem: ${resolution.origin}, valor: ${resolution.license ?? 'nenhum'})`,
        })
        continue
      }

      const dedupKey = `${candidate.type}:${slug(candidate.name)}`
      if (seenBySlug.has(dedupKey)) {
        duplicates.push({ source: source.id, name: candidate.name, keptId: seenBySlug.get(dedupKey)! })
        continue
      }

      let id = `${source.id}-${slug(candidate.name)}`
      let suffix = 2
      const existingIds = new Set(items.map((it) => it.id))
      while (existingIds.has(id)) {
        id = `${source.id}-${slug(candidate.name)}-${suffix}`
        suffix++
      }
      seenBySlug.set(dedupKey, id)

      const dir = `${candidate.type}s/${id}`
      const sha256 = source.materialize ? writeMaterializedFiles(dir, candidate.files) : undefined

      const shortSha = sha.slice(0, 7)
      const item: CatalogItem = {
        id,
        name: candidate.name,
        description: truncate(candidate.description, 1000),
        version: candidate.version ?? shortSha,
        tags: candidate.tags ?? [],
        clis: candidate.clis,
        dir,
        files: candidate.files.map((f) => f.rel),
        ...(sha256 ? { sha256 } : {}),
        type: candidate.type,
        license: resolution.license,
        author: candidate.author ?? source.repo.split('/')[0],
        source: {
          registry: source.id,
          repo: source.repo,
          url: candidate.itemUrl ?? undefined,
          ref: source.ref,
          sha: shortSha,
        },
      }
      items.push(item)
      sourceCount++
    }
    counts[source.id] = sourceCount
    console.log(`[aggregate] fonte "${source.id}": ${sourceCount} itens materializados, ${candidates.length - sourceCount} descartados/needsReview nesta passada.`)
  }

  if (items.length === 0) {
    console.error('[aggregate] nenhum item produzido por nenhuma fonte — abortando sem sobrescrever index.json.')
    process.exitCode = 1
    return
  }

  items.sort((a, b) => (a.type === b.type ? a.id.localeCompare(b.id) : a.type.localeCompare(b.type)))

  const index: CatalogIndex = { version: 1, updatedAt: new Date().toISOString(), items }
  writeFileSync(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`)
  writeAttribution(items)
  writeFileSync(
    REPORT_PATH,
    `${JSON.stringify({ updatedAt: index.updatedAt, counts, totalItems: items.length, needsReview, duplicates }, null, 2)}\n`,
  )

  console.log(`\n[aggregate] index.json escrito com ${items.length} itens (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}).`)
  console.log(`[aggregate] needsReview: ${needsReview.length} · duplicates: ${duplicates.length} — ver report.json.`)
}

function writeAttribution(items: CatalogItem[]): void {
  const rows = items
    .map((it) => {
      const src = it.source
      const link = src?.url ?? (src?.repo ? `https://github.com/${src.repo}` : '')
      return `| ${it.id} | ${it.name} | ${it.type} | ${it.author ?? '—'} | ${it.license ?? '—'} | ${src?.registry ?? '—'} | ${src?.sha ?? '—'} | ${link} |`
    })
    .join('\n')

  const content = `# ATTRIBUTION

> Gerado automaticamente por \`src/aggregate.ts\` — NÃO editar à mão (o próximo run sobrescreve).
> Cada item materializado neste registry preserva a licença e a atribuição originais,
> conforme exigido pelas licenças permissivas (MIT/Apache-2.0/BSD/ISC/CC0/CC-BY) das obras
> upstream — ver política em REGISTRY-INTEGRATION.md §5 (repo Terminal) e README.md.

| id | nome | tipo | autor | licença | fonte | sha | link |
|---|---|---|---|---|---|---|---|
${rows}
`
  writeFileSync(ATTRIBUTION_PATH, content)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
