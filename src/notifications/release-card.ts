import { promises as fs } from 'fs'
import path from 'path'
import { Resvg } from '@resvg/resvg-js'

/**
 * Path to the SVG template, with a single `{{VERSION}}` placeholder.
 * Resolved from the source tree so it works both in `npm run serve`
 * (TS source) and in the built `dist/` output (the assets/ dir is
 * copied at build time via the package "files" field / Dockerfile).
 */
const TEMPLATE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'assets',
  'release-card-template.svg'
)

let cachedTemplate: string | null = null

async function loadTemplate(): Promise<string> {
  if (cachedTemplate !== null) return cachedTemplate
  cachedTemplate = await fs.readFile(TEMPLATE_PATH, 'utf8')
  return cachedTemplate
}

/** Conservative XML-escape for values substituted into the SVG. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Render the release card for `version` to a PNG buffer.
 *
 * Uses @resvg/resvg-js — native, in-process, no headless browser.
 * Output dimensions come from the SVG's own width/height attrs (1200×675
 * for Twitter's recommended 16:9 in-stream image).
 */
export async function renderReleaseCard(version: string): Promise<Buffer> {
  const template = await loadTemplate()
  const svg = template.replace(/\{\{VERSION\}\}/g, escapeXml(version))
  const resvg = new Resvg(svg, { fitTo: { mode: 'original' } })
  return resvg.render().asPng()
}
