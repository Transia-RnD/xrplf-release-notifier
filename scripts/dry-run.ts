/**
 * Dry-run script — renders every notification scenario for a given tag,
 * exercising the full AI summarization pipeline, but POSTS NOTHING.
 *
 * Usage:
 *   npx ts-node scripts/dry-run.ts                  # latest beta tag from XRPLF/rippled
 *   npx ts-node scripts/dry-run.ts 3.2.0-b6         # specific tag
 *   npx ts-node scripts/dry-run.ts 3.1.3 --json     # JSON output (machine-readable)
 *
 * Comms iteration loop: edit prompts in `src/ai/summarizer.ts` (constants
 * at the top), rebuild (`npm run build`), rerun this script, compare output.
 */
import 'dotenv/config'
import axios from 'axios'
import winston from 'winston'
import { summarizeReleaseByTag, Summaries } from '../src/ai/summarizer'
import { formatMessages } from '../src/notifications/formatter'
import {
  VersionInfo,
  NotificationSource,
  VersionType,
} from '../src/version/types'
import { classifyVersion } from '../src/version/parser'

const OWNER = 'XRPLF'
const REPO = 'rippled'

const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const tagArg = args.find((a) => !a.startsWith('--'))

async function pickTag(): Promise<string> {
  if (tagArg) return tagArg
  // Default: latest beta tag
  const res = await axios.get<Array<{ name: string }>>(
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

function buildScenarios(version: ReturnType<typeof classifyVersion>): ScenarioRender[] {
  const tag = version.raw
  const commitUrl = `https://github.com/${OWNER}/${REPO}/commit/example`
  const releaseUrl = `https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`

  // Pick the "BuildInfo bump" scenario by version type
  const sourceBumpBranch =
    version.type === VersionType.BETA ? 'develop' : `release-${version.major}.${version.minor}`

  return [
    {
      scenario: `Source bump (${version.type}) — push to ${sourceBumpBranch} modifying BuildInfo.cpp`,
      source: NotificationSource.WEBHOOK,
      versionInfo: { ...version, branch: sourceBumpBranch, commitSha: 'example', commitUrl },
    },
    {
      scenario: `Tag push — refs/tags/${tag} pushed`,
      source: NotificationSource.TAG,
      versionInfo: { ...version, branch: `tag:${tag}`, commitSha: 'example', commitUrl },
    },
    {
      scenario: `Release published — GitHub Release for ${tag} (action=published)`,
      source: NotificationSource.RELEASE,
      versionInfo: { ...version, branch: `release:${tag}`, commitSha: '', commitUrl: releaseUrl },
    },
    {
      scenario: `Binary poll — new .deb/.rpm for ${tag} on repos.ripple.com`,
      source: NotificationSource.BINARY_POLL,
      versionInfo: { ...version, branch: 'release', commitSha: '', commitUrl: '' },
    },
  ]
}

function renderScenario(s: ScenarioRender, summaries: Summaries) {
  const msgs = formatMessages(s.versionInfo, s.source, summaries)
  const att = msgs.mattermost.attachments?.[0]
  return {
    scenario: s.scenario,
    mattermost: {
      username: msgs.mattermost.username,
      icon_url: msgs.mattermost.icon_url,
      color: att?.color,
      pretext: att?.pretext,
      title: att?.title,
      title_link: att?.title_link,
      text: att?.text,
      footer: att?.footer,
    },
    twitter: msgs.twitter,
    twitter_chars: msgs.twitter.length,
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
      console.log(`  Button:  ${r.mattermost.title}  →  ${r.mattermost.title_link}`)
    }
    if (r.mattermost.text) {
      console.log('  Body:')
      r.mattermost.text.split('\n').forEach((line) => console.log(`    ${line}`))
    }
    console.log(`  Footer:  ${r.mattermost.footer}`)
    console.log()
    console.log('  TWITTER / X')
    console.log('  ───────────')
    console.log(`  (${r.twitter_chars}/280 chars)`)
    console.log(`  ${r.twitter}`)
  }
}

async function main() {
  const logger = winston.createLogger({
    level: jsonMode ? 'error' : 'info',
    format: winston.format.simple(),
    transports: [new winston.transports.Console({ stderrLevels: ['error', 'warn', 'info', 'debug'] })],
  })

  const tag = await pickTag()
  if (!jsonMode) {
    console.log(`\nDry-run for rippled ${tag}`)
    console.log(`Source: ${process.env.ANTHROPIC_API_KEY ? 'AI summaries enabled (Haiku 4.5)' : 'NO ANTHROPIC_API_KEY — summaries will be null'}`)
  }

  let version: ReturnType<typeof classifyVersion>
  try {
    version = classifyVersion(tag)
  } catch (err) {
    console.error(`Tag "${tag}" doesn't match the version pattern (X.Y.Z[-bN|-rcN]).`)
    process.exit(1)
  }

  const summaries = await summarizeReleaseByTag({
    owner: OWNER,
    repo: REPO,
    tag,
    apiKey: process.env.ANTHROPIC_API_KEY,
    githubToken: process.env.GITHUB_TOKEN,
    logger,
  })

  const scenarios = buildScenarios(version)
  const rendered = scenarios.map((s) => renderScenario(s, summaries))

  if (jsonMode) {
    console.log(JSON.stringify({ tag, summaries, scenarios: rendered }, null, 2))
  } else {
    printHuman(rendered)
    console.log('\n' + '═'.repeat(80))
    console.log('  Nothing was posted. To iterate, edit prompts in src/ai/summarizer.ts')
    console.log('  and rerun: npm run build && npx ts-node scripts/dry-run.ts ' + tag)
    console.log('═'.repeat(80) + '\n')
  }
}

main().catch((err) => {
  console.error('dry-run failed:', err)
  process.exit(1)
})
