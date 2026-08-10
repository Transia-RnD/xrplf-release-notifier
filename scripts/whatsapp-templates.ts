/**
 * Create and submit the WhatsApp content templates, and report approval state.
 *
 * WhatsApp rejects business-initiated free-form text (63016), so every page
 * goes out as an approved template. Meta reviews the *shape*, not the values —
 * one parameterised template therefore covers the whole alert catalog, and
 * re-wording it costs another review.
 *
 * Usage:
 *   npx ts-node scripts/whatsapp-templates.ts list
 *   npx ts-node scripts/whatsapp-templates.ts create [--submit]
 */

import dotenv from 'dotenv'
import axios from 'axios'
import { z } from 'zod'
import { getErrorMessage } from '../src/utils/error'

dotenv.config()

const CONTENT_ROOT = 'https://content.twilio.com/v1/Content'

/** Twilio's Content API is external input — parsed, never trusted. */
const CreatedSchema = z.object({ sid: z.string() })

const ContentListSchema = z.object({
  contents: z
    .array(
      z.object({
        sid: z.string(),
        friendly_name: z.string(),
        language: z.string(),
      })
    )
    .default([]),
})

const ApprovalSchema = z.object({
  whatsapp: z
    .object({
      status: z.string().optional(),
      category: z.string().optional(),
      rejection_reason: z.string().nullable().optional(),
    })
    .optional(),
})

/**
 * Meta rejects a body that starts or ends with a variable, or that places two
 * adjacent, so every body below is bracketed by literal text.
 */
interface TemplateSpec {
  friendlyName: string
  /** `utility` is transactional; alerts miscategorised as marketing get rejected. */
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'
  body: string
  /** Sample values — Meta reviews the template rendered with these. */
  variables: Record<string, string>
}

const TEMPLATES: TemplateSpec[] = [
  {
    friendlyName: 'xrplf_pager_test',
    category: 'UTILITY',
    body: 'XRPLF pager test {{1}} — delivery check only, no action needed.',
    variables: { '1': '2026-08-08T15:04Z' },
  },
  {
    friendlyName: 'xrplf_alert',
    category: 'UTILITY',
    body: 'XRPLF {{1}} alert — {{2}}: {{3}}. Full detail in Mattermost.',
    variables: {
      '1': 'CRITICAL',
      '2': 'FORK_DETECTED',
      '3': 'mainnet ledger 98123456, no branch reached quorum',
    },
  },
]

function auth(): { username: string; password: string } {
  const username = process.env.TWILIO_API_KEY_SID
  const password = process.env.TWILIO_API_KEY_SECRET
  if (!username || !password) {
    throw new Error('TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET required')
  }
  return { username, password }
}

/** Twilio reports a missing API-key permission as 70051 and names the scope. */
function report(label: string, err: unknown): void {
  if (axios.isAxiosError(err) && err.response) {
    const data = err.response.data as { code?: number; message?: string }
    console.log(
      `  ${label}: ${data.code ?? err.response.status} ${data.message ?? ''}`
    )
    return
  }
  console.log(`  ${label}: ${getErrorMessage(err)}`)
}

async function list(): Promise<void> {
  try {
    const response = await axios.get(`${CONTENT_ROOT}?PageSize=50`, {
      auth: auth(),
      timeout: 15_000,
    })
    const { contents } = ContentListSchema.parse(response.data)
    console.log(`${contents.length} template(s)`)
    for (const c of contents) {
      console.log(`  ${c.sid}  ${c.friendly_name}  (${c.language})`)
      try {
        const approval = await axios.get(
          `${CONTENT_ROOT}/${c.sid}/ApprovalRequests`,
          { auth: auth(), timeout: 15_000 }
        )
        const { whatsapp: wa } = ApprovalSchema.parse(approval.data)
        console.log(
          `      whatsapp: status=${wa?.status ?? 'not submitted'} category=${wa?.category ?? '-'}` +
            (wa?.rejection_reason ? ` reason=${wa.rejection_reason}` : '')
        )
      } catch (err) {
        report('approval lookup', err)
      }
    }
  } catch (err) {
    report('list', err)
  }
}

async function create(submit: boolean): Promise<void> {
  for (const spec of TEMPLATES) {
    try {
      const response = await axios.post(
        CONTENT_ROOT,
        {
          friendly_name: spec.friendlyName,
          language: 'en',
          variables: spec.variables,
          types: { 'twilio/text': { body: spec.body } },
        },
        { auth: auth(), timeout: 15_000 }
      )
      const { sid } = CreatedSchema.parse(response.data)
      console.log(`created ${sid}  ${spec.friendlyName}`)
      console.log(`  ${spec.body}`)

      if (!submit) continue
      // Approval is a separate round trip; a created template is inert until
      // Meta accepts it.
      await axios.post(
        `${CONTENT_ROOT}/${sid}/ApprovalRequests/whatsapp`,
        { name: spec.friendlyName, category: spec.category },
        { auth: auth(), timeout: 15_000 }
      )
      console.log(`  submitted for ${spec.category} approval`)
    } catch (err) {
      report(spec.friendlyName, err)
    }
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  if (cmd === 'list') return list()
  if (cmd === 'create') return create(process.argv.includes('--submit'))
  throw new Error('usage: whatsapp-templates.ts list | create [--submit]')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
