import { z } from 'zod'

/**
 * Zod schemas for the subset of GitHub webhook payloads this service actually
 * reads. Anything outside these fields is `unknown` from the API but doesn't
 * affect behavior — only the listed fields are load-bearing.
 *
 * Tests live alongside the handler tests in test/unit/webhook/handler.test.ts.
 */

const Commit = z.object({
  added: z.array(z.string()).optional(),
  modified: z.array(z.string()).optional(),
})

export const PushEventSchema = z.object({
  ref: z.string().optional(),
  after: z.string().optional(),
  deleted: z.boolean().optional(),
  commits: z.array(Commit).optional(),
  head_commit: z
    .object({
      id: z.string().optional(),
      url: z.string().optional(),
    })
    .nullable()
    .optional(),
})
export type PushEvent = z.infer<typeof PushEventSchema>

export const ReleaseEventSchema = z.object({
  action: z.string().optional(),
  release: z
    .object({
      tag_name: z.string().optional(),
      html_url: z.string().optional(),
      body: z.string().optional().nullable(),
      draft: z.boolean().optional(),
    })
    .optional(),
})
export type ReleaseEvent = z.infer<typeof ReleaseEventSchema>
