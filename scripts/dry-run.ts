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
 *
 * Comms iteration loop: edit prompts in `src/ai/summarizer.ts` (constants
 * at the top), rebuild (`npm run build`), rerun this script, compare output.
 */
import 'dotenv/config'
import { writeFileSync } from 'fs'
import axios from 'axios'
import winston from 'winston'
import type { Summaries } from '../src/ai/summarizer'
import { summarizeReleaseByTag } from '../src/ai/summarizer'
import { formatMattermost } from '../src/notifications/mattermost'
import { renderReleaseCard } from '../src/notifications/release-card'
import { fetchLatestBinaryVersions } from '../src/poller/binary-checker'
import { PUBLIC_REPO, repoFullName } from '../src/github/repos'
import type { VersionInfo } from '../src/version/types'
import { NotificationSource, VersionType } from '../src/version/types'
import { classifyVersion } from '../src/version/parser'

const OWNER = 'XRPLF'
const REPO = 'rippled'

const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const finalMode = args.includes('--final')
const tagArg = args.find((a) => !a.startsWith('--'))

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

function renderScenario(s: ScenarioRender, summaries: Summaries) {
  const mattermost = formatMattermost(
    s.versionInfo,
    s.source,
    summaries.mattermost
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

  const summaries = await summarizeReleaseByTag({
    owner: OWNER,
    repo: REPO,
    tag,
    apiKey,
    githubToken: process.env.GITHUB_TOKEN,
    logger,
    // Only finals produce a tweet (binary-poll path); beta/RC are Mattermost-only.
    includeTwitter: version.type === VersionType.FINAL,
  })

  const scenarios = buildScenarios(version)
  const rendered = scenarios.map((s) => renderScenario(s, summaries))

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
    console.log('\n' + '═'.repeat(80))
    console.log(
      '  Nothing was posted. To iterate, edit prompts in src/ai/summarizer.ts'
    )
    console.log(
      '  and rerun: npm run build && npx ts-node scripts/dry-run.ts ' + tag
    )
    console.log('═'.repeat(80) + '\n')
  }
}

main().catch((err) => {
  console.error('dry-run failed:', err)
  process.exit(1)
})
