/**
 * Dry-run script — renders every notification scenario for a given tag,
 * exercising the full AI summarization pipeline, but POSTS NOTHING.
 *
 * Usage:
 *   npx ts-node scripts/dry-run.ts                  # latest beta tag from XRPLF/rippled
 *   npx ts-node scripts/dry-run.ts 3.2.0-b6         # specific tag
 *   npx ts-node scripts/dry-run.ts 3.1.3 --json     # JSON output (machine-readable)
 *   npx ts-node scripts/dry-run.ts 3.2.0 --final    # full FINAL flow: tag → release → binary,
 *                                                   # renders the release-card PNG to /tmp
 *   npx ts-node scripts/dry-run.ts 3.1.3 --final --live   # ACTUALLY posts the tweet (with image)
 *   npx ts-node scripts/dry-run.ts 2.2.0 --parity         # SDK feature-parity report (no posting)
 *
 * --base sets the NEW-SURFACE window only; breaking-on-upgrade is ALWAYS vs the
 * previous tag (small, reliable diff — never the 300-file-capped far diff):
 *   (default)                                  # surface vs last release · breaking vs previous tag
 *   npx ts-node scripts/dry-run.ts 3.2.0-b7 --base=last-release  # surface: 3.1.3 → b7 (cumulative)
 *   npx ts-node scripts/dry-run.ts 3.2.0-b7 --base=last-tag      # surface: b6 → b7 (incremental)
 *   npx ts-node scripts/dry-run.ts 3.2.0-b7 --base=3.0.0         # surface vs an explicit tag
 *
 * Comms iteration loop: edit prompts in `src/ai/summarizer.ts` (constants
 * at the top), rebuild (`npm run build`), rerun this script, compare output.
 *
 * --parity needs ANTHROPIC_API_KEY and GITHUB_TOKEN. It builds the rippled
 * reference for the tag, runs the parity agent against each configured SDK,
 * and prints the Mattermost report it WOULD post — nothing is posted or cached.
 */
import 'dotenv/config'
import { writeFileSync } from 'fs'
import axios from 'axios'
import winston from 'winston'
import type { Summaries } from '../src/ai/summarizer'
import { summarizeReleaseByTag } from '../src/ai/summarizer'
import type { BreakingResult } from '../src/ai/breaking'
import { summarizeBreakingForTag } from '../src/ai/breaking'
import { formatMattermost } from '../src/notifications/mattermost'
import { renderReleaseCard } from '../src/notifications/release-card'
import { postToTwitter } from '../src/notifications/twitter'
import { fetchLatestBinaryVersions } from '../src/poller/binary-checker'
import { PUBLIC_REPO, repoFullName } from '../src/github/repos'
import type { VersionInfo } from '../src/version/types'
import { NotificationSource, VersionType } from '../src/version/types'
import { classifyVersion } from '../src/version/parser'
import {
  findLastFinalTag,
  findPredecessorTag,
} from '../src/version/predecessor'
import { loadParityConfig } from '../src/parity/sdks'
import { buildReference, deltaChecklist } from '../src/parity/reference'
import { runSdkAgent } from '../src/parity/runSdkAgent'
import { computeVerdicts, attachInProgressPRs } from '../src/parity/match'
import { runDocsCheck } from '../src/parity/runDocsCheck'
import { getFileAtRef } from '../src/github/client'
import { formatParityReport } from '../src/parity/report'
import type { SdkReport } from '../src/parity/report'

const OWNER = 'XRPLF'
const REPO = 'rippled'

const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const finalMode = args.includes('--final')
const liveMode = args.includes('--live')
const parityMode = args.includes('--parity')
const tagArg = args.find((a) => !a.startsWith('--'))
// --base=last-release | last-tag | <explicit tag>  → override the NEW-SURFACE
// window only. Breaking-on-upgrade is always vs the previous tag. Omit for
// production behaviour (surface vs last stable).
const baseArg = args.find((a) => a.startsWith('--base='))?.split('=')[1]

const OWNER_REPO = { OWNER: 'XRPLF', REPO: 'rippled' }

/** Resolve --base to a surface baseline tag (undefined = default last stable). */
async function resolveBase(
  tag: string
): Promise<{ surfaceBase?: string | null; label: string }> {
  const token = process.env.GITHUB_TOKEN
  const breaking = 'breaking vs previous tag'
  if (!baseArg) {
    return { label: `surface vs last release · ${breaking}` }
  }
  if (baseArg === 'last-release') {
    const surfaceBase = await findLastFinalTag(
      OWNER_REPO.OWNER,
      OWNER_REPO.REPO,
      tag,
      token
    )
    return {
      surfaceBase,
      label: `surface vs last release (${surfaceBase ?? 'none'}) · ${breaking}`,
    }
  }
  if (baseArg === 'last-tag') {
    const surfaceBase = await findPredecessorTag(
      OWNER_REPO.OWNER,
      OWNER_REPO.REPO,
      tag,
      token
    )
    return {
      surfaceBase,
      label: `surface vs previous tag (${surfaceBase ?? 'none'}) · ${breaking}`,
    }
  }
  return { surfaceBase: baseArg, label: `surface vs ${baseArg} · ${breaking}` }
}

async function pickTag(): Promise<string> {
  if (tagArg) return tagArg
  // Default: latest beta tag
  const res = await axios.get<{ name: string }[]>(
    `https://api.github.com/repos/${OWNER}/${REPO}/tags?per_page=20`,
    { headers: { 'User-Agent': 'xrplf-release-notifier-dry-run' } }
  )
  const beta = res.data.find((t) => /^v?\d+\.\d+\.\d+-b\d+$/.test(t.name))
  if (!beta) throw new Error('No beta tag found in the last 20 tags')
  return beta.name.replace(/^v/, '')
}

interface ScenarioRender {
  scenario: string
  source: NotificationSource
  versionInfo: VersionInfo
}

/**
 * Only renders the scenarios that actually post for the given version type.
 * - BETA → tag push only (no GitHub Release, no stable binary)
 * - RC → release published only (tag suppressed, no stable binary)
 * - FINAL → release published + binary poll (tag suppressed)
 */
function buildScenarios(
  version: ReturnType<typeof classifyVersion>
): ScenarioRender[] {
  const tag = version.raw
  const commitUrl = `https://github.com/${OWNER}/${REPO}/commit/example`
  const releaseUrl = `https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`

  if (version.type === VersionType.BETA) {
    return [
      {
        scenario: `Tag push — refs/tags/${tag} pushed`,
        source: NotificationSource.TAG,
        versionInfo: {
          ...version,
          branch: `tag:${tag}`,
          commitSha: 'example',
          commitUrl,
        },
      },
    ]
  }

  const scenarios: ScenarioRender[] = [
    {
      scenario: `Release published — GitHub Release for ${tag} (action=published)`,
      source: NotificationSource.RELEASE,
      versionInfo: {
        ...version,
        branch: `release:${tag}`,
        commitSha: '',
        commitUrl: releaseUrl,
      },
    },
  ]
  if (version.type === VersionType.FINAL) {
    scenarios.push({
      scenario: `Binary poll — new .deb/.rpm for ${tag} on repos.ripple.com`,
      source: NotificationSource.BINARY_POLL,
      versionInfo: {
        ...version,
        branch: 'release',
        commitSha: '',
        commitUrl: '',
      },
    })
  }
  return scenarios
}

function renderScenario(
  s: ScenarioRender,
  summaries: Summaries,
  breaking: BreakingResult
) {
  // Only the tag-push path carries the diff-derived sections; compose them and
  // pick the colour level exactly as the handler does.
  const isTag = s.source === NotificationSource.TAG
  const parts: string[] = []
  if (isTag && breaking.breakingNow) {
    parts.push(
      `**:rotating_light: Breaking on upgrade:**\n${breaking.breakingNow}`
    )
  }
  if (isTag && breaking.newSurface) {
    parts.push(
      `**:sparkles: New protocol surface — SDKs must add support:**\n${breaking.newSurface}`
    )
  }
  const body = [...parts, summaries.mattermost].join('\n\n')
  const level = !isTag
    ? 'none'
    : breaking.hasBreakingNow
      ? 'breaking'
      : breaking.hasNewSurface
        ? 'surface'
        : 'none'
  const mattermost = formatMattermost(
    s.versionInfo,
    s.source,
    body,
    PUBLIC_REPO,
    level
  )
  const att = mattermost.attachments?.[0]
  // Production tweets ONLY from the final binary-poll path. Tag pushes and
  // release-published events (any type, including final) post to Mattermost
  // only — so the dry-run must not imply a tweet for them.
  const tweets = s.source === NotificationSource.BINARY_POLL
  return {
    scenario: s.scenario,
    mattermost: {
      username: mattermost.username,
      icon_url: mattermost.icon_url,
      color: att?.color,
      pretext: att?.pretext,
      title: att?.title,
      title_link: att?.title_link,
      text: att?.text,
      footer: att?.footer,
    },
    tweets,
    twitter: tweets ? summaries.twitter : '',
    twitter_chars: tweets ? summaries.twitter.length : 0,
  }
}

function printHuman(rendered: ReturnType<typeof renderScenario>[]) {
  for (const r of rendered) {
    console.log('\n' + '═'.repeat(80))
    console.log('  ' + r.scenario)
    console.log('═'.repeat(80))
    console.log()
    console.log('  MATTERMOST')
    console.log('  ─────────')
    console.log(`  User:    ${r.mattermost.username}  (avatar via icon_url)`)
    console.log(`  Color:   ${r.mattermost.color}`)
    console.log(`  Pretext: ${r.mattermost.pretext}`)
    if (r.mattermost.title) {
      console.log(
        `  Button:  ${r.mattermost.title}  →  ${r.mattermost.title_link}`
      )
    }
    if (r.mattermost.text) {
      console.log('  Body:')
      r.mattermost.text
        .split('\n')
        .forEach((line) => console.log(`    ${line}`))
    }
    console.log(`  Footer:  ${r.mattermost.footer}`)
    console.log()
    console.log('  TWITTER / X')
    console.log('  ───────────')
    if (r.tweets) {
      console.log(`  (${r.twitter_chars}/280 chars)`)
      console.log(`  ${r.twitter}`)
    } else {
      console.log(
        '  — no tweet (tweets only fire for FINAL binaries on stable)'
      )
    }
  }
}

function printBreaking(
  tag: string,
  breaking: BreakingResult,
  baseLabel: string
) {
  console.log('\n' + '═'.repeat(80))
  console.log(`  BREAKING-CHANGE SCAN — ${tag}  [${baseLabel}]`)
  console.log('═'.repeat(80))
  console.log()
  if (breaking.hasBreakingNow) {
    console.log('  🚨 Breaking on upgrade (tag post → RED):')
    breaking.breakingNow.split('\n').forEach((l) => console.log(`    ${l}`))
    console.log()
  }
  if (breaking.hasNewSurface) {
    console.log(
      '  ✨ New protocol surface — SDKs must add support' +
        (breaking.hasBreakingNow ? ':' : ' (tag post → AMBER):')
    )
    breaking.newSurface.split('\n').forEach((l) => console.log(`    ${l}`))
    console.log()
  }
  if (!breaking.hasBreakingNow && !breaking.hasNewSurface) {
    console.log('  ✓ Nothing flagged — tag post stays blue.')
  }
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is required — set it in .env')
    process.exit(1)
  }

  const logger = winston.createLogger({
    level: jsonMode ? 'error' : 'info',
    format: winston.format.simple(),
    transports: [
      new winston.transports.Console({
        stderrLevels: ['error', 'warn', 'info', 'debug'],
      }),
    ],
  })

  const tag = await pickTag()
  if (!jsonMode) {
    console.log(`\nDry-run for rippled ${tag}`)
  }

  let version: ReturnType<typeof classifyVersion>
  try {
    version = classifyVersion(tag)
  } catch (err) {
    console.error(
      `Tag "${tag}" doesn't match the version pattern (X.Y.Z[-bN|-rcN]).`
    )
    process.exit(1)
  }

  if (parityMode) {
    await runParityDryRun(tag, version, logger)
    return
  }

  const { surfaceBase: scanBase, label: scanLabel } = await resolveBase(tag)

  // Narrative summary + diff-based breaking scan, in parallel — same as the
  // tag-push handler. The breaking scan degrades to "none" on any failure.
  const [summaries, breaking] = await Promise.all([
    summarizeReleaseByTag({
      owner: OWNER,
      repo: REPO,
      tag,
      apiKey,
      githubToken: process.env.GITHUB_TOKEN,
      logger,
      // Only finals produce a tweet (binary-poll path); beta/RC are Mattermost-only.
      includeTwitter: version.type === VersionType.FINAL,
      // BETA renders the tag-push path, where the diff detector owns the
      // breaking section; RC/FINAL render release/binary paths that keep the
      // labeled section. Mirror the handler so the dry-run is faithful.
      labelBreaking: version.type !== VersionType.BETA,
    }),
    summarizeBreakingForTag({
      owner: OWNER,
      repo: REPO,
      tag,
      apiKey,
      githubToken: process.env.GITHUB_TOKEN,
      logger,
      surfaceBase: scanBase,
    }).catch((err: unknown) => {
      logger.warn(
        `Breaking scan failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return {
        breakingNow: '',
        newSurface: '',
        hasBreakingNow: false,
        hasNewSurface: false,
      } as BreakingResult
    }),
  ])

  const scenarios = buildScenarios(version)
  const rendered = scenarios.map((s) => renderScenario(s, summaries, breaking))

  // For --final, render the release card PNG to /tmp, scrape pool/stable
  // to confirm the .deb/.rpm are actually live, and assemble the exact
  // tweet text the binary-poll path would post.
  let releaseCardPath: string | undefined
  let finalTweetText: string | undefined
  let binaryStatus:
    | { deb: string | null; rpm: string | null; matchesTag: boolean }
    | undefined
  if (finalMode) {
    if (version.type !== VersionType.FINAL) {
      console.error(
        `--final requires a FINAL tag (X.Y.Z without -bN/-rcN); got: ${tag}`
      )
      process.exit(1)
    }
    const png = await renderReleaseCard(tag)
    releaseCardPath = `/tmp/release-card-${tag}.png`
    writeFileSync(releaseCardPath, png)
    const releaseNotesUrl = `https://github.com/${repoFullName(PUBLIC_REPO)}/releases/tag/${tag}`
    finalTweetText = `${summaries.twitter}\n\nRelease notes: ${releaseNotesUrl}`

    // Actually hit repos.ripple.com to verify the binary is there — this
    // is what /poll does in production before deciding to tweet.
    const latest = await fetchLatestBinaryVersions()
    binaryStatus = {
      deb: latest.deb,
      rpm: latest.rpm,
      matchesTag: latest.deb === tag && latest.rpm === tag,
    }
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          tag,
          summaries,
          breaking,
          scenarios: rendered,
          ...(finalMode
            ? { releaseCardPath, finalTweetText, binaryStatus }
            : {}),
        },
        null,
        2
      )
    )
  } else {
    printBreaking(tag, breaking, scanLabel)
    printHuman(rendered)
    if (finalMode) {
      console.log('\n' + '═'.repeat(80))
      console.log('  BINARY POLL — repos.ripple.com/pool/stable/')
      console.log('═'.repeat(80))
      console.log()
      console.log(`  Looking for tag:  ${tag}`)
      console.log(`  Latest .deb:      ${binaryStatus?.deb ?? '(none)'}`)
      console.log(`  Latest .rpm:      ${binaryStatus?.rpm ?? '(none)'}`)
      console.log()
      if (binaryStatus?.matchesTag) {
        console.log(
          `  ✓ Binary for ${tag} IS live on pool/stable — /poll would tweet now.`
        )
      } else {
        console.log(
          `  ✗ Binary for ${tag} is NOT yet on pool/stable — /poll would still be waiting.`
        )
        console.log(
          `    (The tweet below is what would fire ONCE the binary lands.)`
        )
      }
      console.log('\n' + '═'.repeat(80))
      console.log('  TWITTER POST (binary-on-stable, what /poll would send)')
      console.log('═'.repeat(80))
      console.log()
      console.log(`  Image:    ${releaseCardPath}`)
      console.log(`  Open it:  open "${releaseCardPath}"`)
      console.log()
      console.log('  Text:')
      finalTweetText?.split('\n').forEach((line) => console.log(`    ${line}`))
      console.log(
        `  (${finalTweetText?.length ?? 0}/280 chars, image attached)`
      )
    }

    if (liveMode) {
      console.log('\n' + '═'.repeat(80))
      console.log('  ⚠️  LIVE POST — actually tweeting now (with image)')
      console.log('═'.repeat(80))
      if (!finalMode) {
        console.error('  --live requires --final. Aborting.')
        process.exit(1)
      }
      const creds = {
        appKey: process.env.TWITTER_API_KEY ?? '',
        appSecret: process.env.TWITTER_API_SECRET ?? '',
        accessToken: process.env.TWITTER_ACCESS_TOKEN ?? '',
        accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET ?? '',
      }
      const missing = Object.entries(creds)
        .filter(([, v]) => !v || v === 'placeholder')
        .map(([k]) => k)
      if (missing.length > 0) {
        console.error(
          `  Missing/placeholder Twitter creds: ${missing.join(', ')}`
        )
        console.error('  Set them in .env first, then re-run.')
        process.exit(1)
      }
      if (!finalTweetText) {
        console.error('  No tweet text assembled. Aborting.')
        process.exit(1)
      }
      try {
        const png = await renderReleaseCard(tag)
        await postToTwitter(creds, finalTweetText, {
          buffer: png,
          mimeType: 'image/png',
        })
        console.log('  ✓ Tweet posted successfully.')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  ✗ Tweet failed: ${msg}`)
        process.exit(1)
      }
    }

    console.log('\n' + '═'.repeat(80))
    if (liveMode) {
      console.log('  Live post complete. Check your timeline.')
    } else {
      console.log(
        '  Nothing was posted. To iterate, edit prompts in src/ai/summarizer.ts'
      )
      console.log(
        '  and rerun: npm run build && npx ts-node scripts/dry-run.ts ' + tag
      )
    }
    console.log('═'.repeat(80) + '\n')
  }
}

async function runParityDryRun(
  tag: string,
  version: ReturnType<typeof classifyVersion>,
  logger: winston.Logger
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const githubToken = process.env.GITHUB_TOKEN
  if (!githubToken) {
    console.error(
      'GITHUB_TOKEN is required for --parity (anonymous GitHub is 60 req/hr).'
    )
    process.exit(1)
  }

  const parityConfig = loadParityConfig()
  console.log(`\nBuilding rippled reference for ${tag}…`)
  const reference = await buildReference({
    repo: parityConfig.rippled.repo,
    tag,
    githubToken,
    logger,
  })
  console.log(
    `  predecessor: ${reference.predecessorTag ?? '(none)'} — ${reference.added.length} new feature(s) this release`
  )
  for (const f of reference.added) console.log(`    + ${f.name} (${f.kind})`)
  if (reference.addedAmendments.length) {
    console.log(`  new amendments: ${reference.addedAmendments.join(', ')}`)
  }

  const checklist = deltaChecklist(reference)
  const sdks: SdkReport[] = []
  if (checklist.length > 0) {
    for (const sdk of parityConfig.sdks) {
      console.log(`\nAuditing ${sdk.name} (${sdk.repo}@${sdk.ref})…`)
      try {
        const inventory = await runSdkAgent({
          apiKey: apiKey ?? '',
          repo: sdk.repo,
          ref: sdk.ref,
          sdkName: sdk.name,
          githubToken,
          logger,
        })
        const defPath = inventory.resolvedLocations.definitions
        const defs = defPath
          ? await getFileAtRef(sdk.repo, defPath, sdk.ref, githubToken)
          : null
        const features = computeVerdicts(checklist, inventory, defs)
        await attachInProgressPRs(
          sdk.repo,
          features.filter((f) => f.level2 !== 'supported'),
          githubToken,
          logger
        )
        const result = {
          repo: sdk.repo,
          ref: sdk.ref,
          resolvedLocations: inventory.resolvedLocations,
          runtimeDefinitions: inventory.runtimeDefinitions,
          features,
          notes: inventory.notes,
        }
        sdks.push({ name: sdk.name, repo: sdk.repo, result })
        if (jsonMode) console.log(JSON.stringify(result, null, 2))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`  ✗ ${sdk.name} failed: ${message}`)
        sdks.push({ name: sdk.name, repo: sdk.repo, error: message })
      }
    }
  }

  const payload = formatParityReport({
    versionType: version.type,
    reference,
    sdks,
  })
  const att = payload.attachments?.[0]
  console.log('\n' + '═'.repeat(80))
  console.log('  MATTERMOST PARITY REPORT (not posted)')
  console.log('═'.repeat(80))
  console.log(`  Color:   ${att?.color}`)
  console.log(`  Pretext: ${att?.pretext}`)
  if (att?.text) {
    console.log('  Body:')
    att.text.split('\n').forEach((l) => console.log(`    ${l}`))
  }
  console.log('═'.repeat(80) + '\n')

  console.log(`Running docs parity against ${parityConfig.docs.repo}…`)
  const docsPayload = await runDocsCheck({
    reference,
    versionType: version.type,
    mode: 'delta',
    docs: parityConfig.docs,
    githubToken,
    logger,
  })
  const docsAtt = docsPayload?.attachments?.[0]
  console.log('\n' + '═'.repeat(80))
  console.log('  MATTERMOST DOCS PARITY REPORT (not posted)')
  console.log('═'.repeat(80))
  if (!docsAtt) {
    console.log('  (nothing to check or docs check failed — see logs)')
  } else {
    console.log(`  Color:   ${docsAtt.color}`)
    console.log(`  Pretext: ${docsAtt.pretext}`)
    if (docsAtt.text) {
      console.log('  Body:')
      docsAtt.text.split('\n').forEach((l) => console.log(`    ${l}`))
    }
  }
  console.log('═'.repeat(80) + '\n')
}

main().catch((err) => {
  console.error('dry-run failed:', err)
  process.exit(1)
})
