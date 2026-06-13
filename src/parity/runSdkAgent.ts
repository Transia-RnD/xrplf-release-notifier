import { readFileSync } from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import type { Logger } from 'winston'
import { z } from 'zod'
import { TOOLS, executeTool } from './githubTools'
import type { ToolContext } from './githubTools'
import type { SdkLocations } from './cache'
import { getFileAtRef } from '../github/client'

/**
 * Runs the inventory skill against one SDK via an Anthropic tool-use loop. The
 * model navigates the repo with read-only GitHub tools and ends by calling
 * `submit_inventory` with the SDK's typed TRANSACTION models. It does NOT judge
 * parity; the caller matches this inventory against the rippled transaction set
 * deterministically (see match.ts). A base methodology skill plus an optional
 * per-SDK profile (config/sdk-skills/<name>.md) form the system prompt, so the
 * agent follows a pinned playbook per SDK instead of re-deriving structure.
 */

// Haiku is enough here: the agent's only job is to ENUMERATE the SDK's typed
// transaction models (read the model dir + registry and list names) — parity is
// decided deterministically in match.ts, and the inventory is verifiable against
// the registry. Bump to 'claude-sonnet-4-6' if enumeration completeness slips.
const MODEL = 'claude-haiku-4-5'
const MAX_TOKENS = 8192
const MAX_ITERATIONS = 60

const CONFIG_DIR = path.resolve(__dirname, '..', '..', 'config')
const SKILL_PATH = path.resolve(CONFIG_DIR, 'parity-skill.md')
const SDK_SKILL_DIR = path.resolve(CONFIG_DIR, 'sdk-skills')

let cachedSkill: string | null = null
function loadSkill(): string {
  if (cachedSkill === null) cachedSkill = readFileSync(SKILL_PATH, 'utf8')
  return cachedSkill
}

const sdkSkillCache = new Map<string, string>()

/**
 * Load the optional per-SDK profile (`config/sdk-skills/<name>.md`): a pinned
 * description of THAT SDK's typed-transaction layout (model dir, registry,
 * wire-name rule) so the agent follows a known playbook instead of re-deriving
 * structure every run — the anti-drift the per-SDK files exist for. Returns ''
 * when there's no profile (the base skill's discovery applies). Each profile
 * tells the agent to fall back to discovery + note drift if the repo no longer
 * matches, so a refactor surfaces rather than silently mislabels.
 */
function loadSdkSkill(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '')
  const cached = sdkSkillCache.get(safe)
  if (cached !== undefined) return cached
  let content = ''
  try {
    content = readFileSync(path.resolve(SDK_SKILL_DIR, `${safe}.md`), 'utf8')
  } catch {
    content = '' // no profile for this SDK — base skill's discovery applies
  }
  sdkSkillCache.set(safe, content)
  return content
}

// ── Verdict types (produced deterministically by match.ts, rendered by report.ts) ──

export type FeatureKind = 'transactionType' | 'ledgerEntryType' | 'field'
export type Level2 = 'supported' | 'declared-only' | 'missing'

export interface InProgressPR {
  number: number
  score: number
}

export interface FeatureVerdict {
  name: string
  kind: FeatureKind
  level1Serialization: boolean
  level2: Level2
  evidence: string[]
  inProgressPR?: InProgressPR | null
}

export interface ResolvedLocations {
  definitions: string | null
  models: string[]
  registries: string[]
}

export interface SdkParityResult {
  repo: string
  ref: string
  resolvedLocations: ResolvedLocations
  runtimeDefinitions: boolean
  features: FeatureVerdict[]
  notes: string
}

// ── Agent output: the inventory ──

const InventorySchema = z.object({
  repo: z.string(),
  ref: z.string(),
  resolvedLocations: z.object({
    definitions: z.string().nullable(),
    models: z.array(z.string()).default([]),
    registries: z.array(z.string()).default([]),
  }),
  runtimeDefinitions: z.boolean().default(false),
  typedTransactionTypes: z.array(z.string()).default([]),
  notes: z.string().default(''),
})

export type SdkInventory = z.infer<typeof InventorySchema>

/** The terminal tool the skill calls to deliver the SDK's typed-model inventory. */
const SUBMIT_TOOL: Anthropic.Tool = {
  name: 'submit_inventory',
  description:
    "Submit this SDK's typed-model inventory. Call exactly once, after reading the model directories and registry.",
  input_schema: {
    type: 'object',
    properties: {
      repo: { type: 'string' },
      ref: { type: 'string' },
      resolvedLocations: {
        type: 'object',
        properties: {
          definitions: { type: ['string', 'null'] },
          models: { type: 'array', items: { type: 'string' } },
          registries: { type: 'array', items: { type: 'string' } },
        },
        required: ['definitions', 'models', 'registries'],
      },
      runtimeDefinitions: { type: 'boolean' },
      typedTransactionTypes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Wire-names of transactions the SDK models as typed constructs. Transactions only — not ledger objects, requests, or helpers.',
      },
      notes: { type: 'string' },
    },
    required: ['repo', 'ref', 'resolvedLocations', 'typedTransactionTypes'],
  },
}

export interface RunSdkAgentOptions {
  apiKey: string
  repo: string
  ref: string
  /** SDK config name — selects the per-SDK profile (config/sdk-skills/<name>.md). */
  sdkName?: string
  /** Cached locations from a prior run, passed as a verification hint. */
  hints?: SdkLocations | null
  githubToken?: string
  logger?: Logger
}

/** Base methodology + the optional per-SDK profile, as one system prompt. */
function systemPrompt(sdkName?: string): string {
  const base = loadSkill()
  const profile = sdkName ? loadSdkSkill(sdkName) : ''
  return profile
    ? `${base}\n\n---\n\n# Profile for this SDK (\`${sdkName}\`)\n\nThis is the known layout for this specific SDK. Follow it; if the repo no longer matches, fall back to the discovery method above and say so in \`notes\`.\n\n${profile}`
    : base
}

function buildUserMessage(opts: RunSdkAgentOptions): string {
  const hints = opts.hints
    ? `\n\nHINTS from a previous run (verify, don't trust):\n` +
      `  definitions: ${opts.hints.definitions ?? '(unknown)'}\n` +
      `  models: ${opts.hints.models.join(', ') || '(unknown)'}\n` +
      `  registries: ${opts.hints.registries.join(', ') || '(unknown)'}`
    : ''
  return (
    `Inventory the typed transaction models in this SDK.\n\n` +
    `repo: ${opts.repo}\nref: ${opts.ref}${hints}\n\n` +
    `Follow the skill (and the per-SDK profile if one is provided). List every ` +
    `typed TRANSACTION model the SDK has. Call submit_inventory exactly once ` +
    `when done.`
  )
}

/** Run the inventory agent for one SDK and return its typed-model inventory. */
export async function runSdkAgent(
  opts: RunSdkAgentOptions
): Promise<SdkInventory> {
  // maxRetries above the SDK default (2) so a transient 429 self-heals via the
  // SDK's Retry-After backoff rather than failing the whole SDK.
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 6 })
  const ctx: ToolContext = {
    repo: opts.repo,
    ref: opts.ref,
    token: opts.githubToken,
  }
  const tools = [...TOOLS, SUBMIT_TOOL]

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildUserMessage(opts) },
  ]

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt(opts.sdkName),
      tools,
      messages,
    })

    messages.push({ role: 'assistant', content: response.content })

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    )

    const submit = toolUses.find((t) => t.name === 'submit_inventory')
    if (submit) {
      const inventory = InventorySchema.parse(submit.input)
      opts.logger?.info('Inventory agent completed', {
        repo: opts.repo,
        iterations: iter + 1,
        txTypes: inventory.typedTransactionTypes.length,
      })
      return inventory
    }

    if (toolUses.length === 0) {
      messages.push({
        role: 'user',
        content:
          'You have not called submit_inventory yet. Finish reading the model directories and call submit_inventory now.',
      })
      continue
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const use of toolUses) {
      let content: string
      try {
        content = await executeTool(
          use.name,
          (use.input ?? {}) as Record<string, unknown>,
          ctx
        )
      } catch (err: unknown) {
        content = `Tool error: ${err instanceof Error ? err.message : String(err)}`
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content,
      })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  throw new Error(
    `Inventory agent for ${opts.repo} exceeded ${MAX_ITERATIONS} iterations without submitting`
  )
}

/**
 * Deterministic presence check for a list of wire-names against an SDK's
 * definitions.json. Used for Level-1 serialization coverage (types and the
 * full-sweep field count). Returns the names split into present/missing; if the
 * file can't be fetched, treats all as missing.
 */
export async function checkPresence(
  repo: string,
  ref: string,
  definitionsPath: string,
  names: string[],
  githubToken: string | undefined
): Promise<{ present: string[]; missing: string[] }> {
  const content = await getFileAtRef(repo, definitionsPath, ref, githubToken)
  if (content === null) return { present: [], missing: [...names] }
  const present: string[] = []
  const missing: string[] = []
  for (const n of names) {
    ;(content.includes(`"${n}"`) ? present : missing).push(n)
  }
  return { present, missing }
}
