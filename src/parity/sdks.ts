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

const ConfigSchema = z.object({
  rippled: z.object({
    repo: z.string().regex(/^[^/]+\/[^/]+$/, 'repo must be "owner/name"'),
  }),
  sdks: z.array(SdkSchema).min(1),
})

export type SdkTarget = z.infer<typeof SdkSchema>
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

/** Split an "owner/name" string into its parts. */
export function splitRepo(fullName: string): { owner: string; name: string } {
  const [owner, name] = fullName.split('/')
  return { owner, name }
}
