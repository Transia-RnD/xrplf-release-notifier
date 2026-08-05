/**
 * Manually run the SDK feature-parity check for a rippled tag and POST the
 * report to Mattermost (the real production path — unlike dry-run, which only
 * prints). Useful for backfilling a report or running a beta against the last
 * final.
 *
 * Usage:
 *   npx ts-node scripts/run-parity.ts <tag> [predecessorTag]      # delta (per-release)
 *   npx ts-node scripts/run-parity.ts <ref> --full                # full backlog sweep
 *
 *   npx ts-node scripts/run-parity.ts 3.2.0-b7 3.1.3
 *     -> "what's new in 3.2.0" = 3.2.0-b7 vs the last final 3.1.3, beta heads-up.
 *   npx ts-node scripts/run-parity.ts 3.1.3 --full
 *     -> FULL parity: every tx + ledger type at 3.1.3 checked against each SDK
 *        (catches backlog, not just this release's delta). Use a final tag, or
 *        `develop` for the bleeding-edge main-branch picture.
 *   npx ts-node scripts/run-parity.ts 3.2.0 --dry --docs-only
 *     -> only the xrpl.org docs-parity check (deterministic, no Anthropic call).
 *
 * Requires ANTHROPIC_API_KEY, GITHUB_TOKEN, and MATTERMOST_WEBHOOK_URL in .env.
 */
import 'dotenv/config'
import { Storage } from '@google-cloud/storage'
import winston from 'winston'
import { loadConfig } from '../src/config'
import { classifyVersion } from '../src/version/parser'
import type { VersionInfo } from '../src/version/types'
import { runParityCheck } from '../src/parity/runParityCheck'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const fullMode = args.includes('--full')
  const dryRun = args.includes('--dry')
  const docsOnly = args.includes('--docs-only')
  const positional = args.filter((a) => !a.startsWith('--'))
  const tag = positional[0]
  const predecessorTag = fullMode ? undefined : positional[1]
  if (!tag) {
    console.error(
      'usage: run-parity.ts <tag> [predecessorTag] [--full] [--dry] [--docs-only]'
    )
    process.exit(1)
  }

  const config = await loadConfig()
  if (!dryRun && !config.mattermostWebhookUrl) {
    console.error('MATTERMOST_WEBHOOK_URL is not set — refusing to run a post.')
    process.exit(1)
  }
  if (!config.githubToken) {
    console.error('GITHUB_TOKEN is required (anonymous GitHub is 60 req/hr).')
    process.exit(1)
  }

  const storage = new Storage({ projectId: config.gcpProjectId })
  const logger = winston.createLogger({
    level: 'info',
    format: winston.format.simple(),
    transports: [new winston.transports.Console()],
  })

  const classified = classifyVersion(tag.replace(/^v/, ''))
  const version: VersionInfo = {
    ...classified,
    branch: `manual:${tag}`,
    commitSha: '',
    commitUrl: '',
  }

  console.log(
    `Running ${fullMode ? 'FULL' : 'delta'} parity${docsOnly ? ' (docs only)' : ''} for ${tag}` +
      `${predecessorTag ? ` (predecessor ${predecessorTag})` : ''}` +
      `${dryRun ? ' — DRY RUN (no post)' : ' — will POST to Mattermost'}…`
  )
  const payloads = await runParityCheck(
    version,
    { config, storage, logger },
    { predecessorTag, mode: fullMode ? 'full' : 'delta', dryRun, docsOnly }
  )

  if (dryRun) {
    for (const [label, payload] of [
      ['SDK PARITY', payloads?.sdk],
      ['DOCS PARITY', payloads?.docs],
    ] as const) {
      if (!payload) continue
      const att = payload.attachments?.[0]
      console.log('\n' + '═'.repeat(80))
      console.log(`  MATTERMOST ${label} REPORT (DRY RUN — not posted)`)
      console.log('═'.repeat(80))
      console.log(`  Color:   ${att?.color ?? '(none)'}`)
      console.log(`  Pretext: ${att?.pretext ?? '(none)'}`)
      if (att?.text) {
        console.log('  Body:')
        att.text.split('\n').forEach((l) => console.log(`    ${l}`))
      }
      console.log('═'.repeat(80) + '\n')
    }
  } else {
    console.log('Done — report(s) posted to Mattermost.')
  }
}

main().catch((err) => {
  console.error('run-parity failed:', err)
  process.exit(1)
})
