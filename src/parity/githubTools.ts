import type Anthropic from '@anthropic-ai/sdk'
import {
  getFileAtRef,
  listDir,
  searchCode,
  listPullRequests,
  fetchPrFiles,
} from '../github/client'

/**
 * Read-only GitHub tools the parity agent uses to navigate an SDK repo. Bound
 * to one repo@ref via ToolContext. Everything is path-agnostic — the agent
 * discovers structure with these, which is what lets the skill stay free of
 * hardcoded locations.
 */

export interface ToolContext {
  repo: string
  ref: string
  token?: string
}

/** Cap on file content returned to the model, to bound token usage. */
const MAX_FILE_CHARS = 30_000
/** Cap on grep matches returned. */
const MAX_GREP_LINES = 60

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'listDir',
    description:
      'List the immediate entries (files and subdirectories) of a directory in the repo. Use "" or "/" for the repo root. Returns each entry name and whether it is a file or dir.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Directory path, e.g. "src/models/transactions". Empty for repo root.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'readFile',
    description: `Read a file's text content (truncated to ${MAX_FILE_CHARS} chars). For large files like definitions.json, prefer grepFile.`,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path within the repo.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'grepFile',
    description:
      'Search a single file for a substring (case-sensitive) and return matching lines with line numbers. Ideal for checking whether an exact wire-name appears in definitions.json or a registry file without reading the whole file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path within the repo.' },
        query: {
          type: 'string',
          description: 'Exact substring to find, e.g. "MPTokenIssuanceCreate".',
        },
      },
      required: ['path', 'query'],
    },
  },
  {
    name: 'searchCode',
    description:
      'Search the whole repo (default branch) for code/filenames matching a query, via the GitHub code-search API. Returns matching file paths. May return empty on rate limits — fall back to listDir navigation.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search terms, e.g. "definitions.json" or "MPTokenIssuanceCreate filename:transaction".',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'listPRs',
    description:
      'List open pull requests for the repo (number, title, branch). Use to find in-progress work for missing features.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'prFiles',
    description:
      'List the files changed in a pull request, with patch snippets where available. Use to confirm a PR actually adds a feature (touches definitions.json / a model file).',
    input_schema: {
      type: 'object',
      properties: {
        number: { type: 'number', description: 'PR number.' },
      },
      required: ['number'],
    },
  },
]

/** Execute a tool call and return a string result for the model. */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const { repo, ref, token } = ctx
  switch (name) {
    case 'listDir': {
      const entries = await listDir(repo, String(input.path ?? ''), ref, token)
      if (entries === null) return `Not found: ${String(input.path)}`
      return (
        entries
          .map((e) => `${e.type === 'dir' ? '[dir] ' : ''}${e.path}`)
          .join('\n') || '(empty)'
      )
    }
    case 'readFile': {
      const content = await getFileAtRef(repo, String(input.path), ref, token)
      if (content === null) return `Not found: ${String(input.path)}`
      if (content.length > MAX_FILE_CHARS) {
        return `${content.slice(0, MAX_FILE_CHARS)}\n\n[truncated at ${MAX_FILE_CHARS} chars — use grepFile to search the rest]`
      }
      return content
    }
    case 'grepFile': {
      const content = await getFileAtRef(repo, String(input.path), ref, token)
      if (content === null) return `Not found: ${String(input.path)}`
      const query = String(input.query)
      const lines = content.split('\n')
      const hits: string[] = []
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(query)) {
          hits.push(`${i + 1}: ${lines[i].trim()}`)
          if (hits.length >= MAX_GREP_LINES) {
            hits.push(`[... more than ${MAX_GREP_LINES} matches, truncated]`)
            break
          }
        }
      }
      return hits.length
        ? hits.join('\n')
        : `No match for "${query}" in ${String(input.path)}`
    }
    case 'searchCode': {
      const hits = await searchCode(repo, String(input.query), token)
      return hits.length ? hits.map((h) => h.path).join('\n') : '(no results)'
    }
    case 'listPRs': {
      const prs = await listPullRequests(repo, token)
      return prs.length
        ? prs.map((p) => `#${p.number} [${p.branch}] ${p.title}`).join('\n')
        : '(no open PRs)'
    }
    case 'prFiles': {
      const files = await fetchPrFiles(repo, Number(input.number), token)
      return files.length
        ? files
            .map(
              (f) =>
                `${f.status} ${f.path}${f.patch ? `\n${f.patch.slice(0, 2000)}` : ''}`
            )
            .join('\n\n')
        : '(no files)'
    }
    default:
      return `Unknown tool: ${name}`
  }
}
