import { readFileSync } from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { z } from 'zod'

/**
 * Parity config. Deliberately MINIMAL — only durable, human-owned facts:
 * which repos and which branch. No file paths and no capability flags live
 * here. Every location (definitions.json, typed-model dirs, registry wiring)
 * and the runtime-definitions capability are DISCOVERED by the parity agent
 * from each repo itself (see config/parity-skill.md), so an SDK refactor never
 * forces a config edit. See config/sdk-architecture.md for human reference.
 */

const SdkSchema = z.object({
  /** Display name, e.g. "xrpl.js". */
  name: z.string().min(1),
  /** GitHub `owner/repo`, e.g. "XRPLF/xrpl.js". */
  repo: z.string().regex(/^[^/]+\/[^/]+$/, 'repo must be "owner/name"'),
  /** Branch (or tag/sha) to audit. */
  ref: z.string().min(1),
})

const DocsSchema = z.object({
  /** GitHub `owner/repo` of the xrpl.org source, e.g. "XRPLF/xrpl-dev-portal". */
  repo: z.string().regex(/^[^/]+\/[^/]+$/, 'repo must be "owner/name"'),
  /** Branch the site is published from. */
  ref: z.string().min(1),
})

const XlsSchema = z.object({
  /** GitHub `owner/repo` of the standards repo, e.g. "XRPLF/XRPL-Standards". */
  repo: z.string().regex(/^[^/]+\/[^/]+$/, 'repo must be "owner/name"'),
  /** Branch specs are merged to. */
  ref: z.string().min(1),
})

const ConfigSchema = z.object({
  rippled: z.object({
    repo: z.string().regex(/^[^/]+\/[^/]+$/, 'repo must be "owner/name"'),
  }),
  sdks: z.array(SdkSchema).min(1),
  docs: DocsSchema,
  xls: XlsSchema,
})

export type SdkTarget = z.infer<typeof SdkSchema>
export type DocsTarget = z.infer<typeof DocsSchema>
export type XlsTarget = z.infer<typeof XlsSchema>
export type ParityConfig = z.infer<typeof ConfigSchema>

/**
 * Resolved from the source tree so it works both in `npm run serve` (TS source,
 * __dirname = src/parity) and in built `dist/` output (dist/parity) — the
 * config/ dir is copied into the runtime image by the Dockerfile, mirroring
 * how assets/ is handled.
 */
const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config', 'sdks.yaml')

let cached: ParityConfig | null = null

/** Load and validate config/sdks.yaml. Cached after first read. */
export function loadParityConfig(
  configPath: string = CONFIG_PATH
): ParityConfig {
  if (cached && configPath === CONFIG_PATH) return cached
  const raw = readFileSync(configPath, 'utf8')
  const parsed = yaml.load(raw)
  const config = ConfigSchema.parse(parsed)
  if (configPath === CONFIG_PATH) cached = config
  return config
}

const XlsMapSchema = z.object({
  /** Amendment name -> XLS number, overriding every inferred match. */
  aliases: z.record(z.string(), z.number().int().positive()).default({}),
  /** Amendments that predate the XLS process — "no spec" is correct for them. */
  legacy: z.array(z.string()).default([]),
})

export type XlsMap = z.infer<typeof XlsMapSchema>

const XLS_MAP_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'config',
  'xls-map.yaml'
)

let cachedXlsMap: XlsMap | null = null

/** Load and validate config/xls-map.yaml. Cached after first read. */
export function loadXlsMap(configPath: string = XLS_MAP_PATH): XlsMap {
  if (cachedXlsMap && configPath === XLS_MAP_PATH) return cachedXlsMap
  const map = XlsMapSchema.parse(yaml.load(readFileSync(configPath, 'utf8')))
  if (configPath === XLS_MAP_PATH) cachedXlsMap = map
  return map
}

/** Split an "owner/name" string into its parts. */
export function splitRepo(fullName: string): { owner: string; name: string } {
  const [owner, name] = fullName.split('/')
  return { owner, name }
}
