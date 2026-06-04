import { promises as fs } from 'fs'
import path from 'path'
import { Resvg } from '@resvg/resvg-js'

/**
 * Path to the SVG template. The version slot is a live `<text>` element
 * containing the literal string `X.Y.Z`, which we substitute at render
 * time. `X.Y.Z` was chosen over `{{VERSION}}` because its 5-character
 * width matches a typical rippled version exactly, so the designer sees
 * accurate placement in their tool.
 *
 * Resolved from the source tree so it works both in `npm run serve`
 * (TS source) and in the built `dist/` output (the assets/ dir is
 * copied at build time via the Dockerfile).
 */
const TEMPLATE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'assets',
  'release-card-template.svg'
)

const FONT_DIR = path.resolve(__dirname, '..', '..', 'assets', 'fonts')

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
 * Output dimensions come from the SVG's own width/height attrs.
 */
export async function renderReleaseCard(version: string): Promise<Buffer> {
  const template = await loadTemplate()
  const svg = template.replace(/X\.Y\.Z/g, escapeXml(version))
  // Bundle Roboto Black (900) + Bold (700) so the render matches the
  // designer's spec on any host. Without these, resvg silently falls back
  // to a system sans (Arial on macOS, DejaVu on node:20-slim) and the
  // version text looks much thinner than intended.
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: {
      fontDirs: [FONT_DIR],
      loadSystemFonts: false,
      defaultFontFamily: 'Roboto',
    },
  })
  return resvg.render().asPng()
}
