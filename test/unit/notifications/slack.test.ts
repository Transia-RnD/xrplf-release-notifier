import {
  toMrkdwn,
  toSlackPayload,
  mirrorToSlack,
} from '../../../src/notifications/slack'
import type { MattermostPayload } from '../../../src/notifications/mattermost'
import axios from 'axios'

jest.mock('axios')

describe('toMrkdwn', () => {
  it('converts bold and links to Slack mrkdwn', () => {
    expect(toMrkdwn('**Breaking changes:** see [notes](https://x.y/z)')).toBe(
      '*Breaking changes:* see <https://x.y/z|notes>'
    )
  })
  it('passes inline code and emoji shortcodes through', () => {
    expect(toMrkdwn(':sparkles: Amendment `Sponsor`')).toBe(
      ':sparkles: Amendment `Sponsor`'
    )
  })
})

describe('toSlackPayload', () => {
  it('maps the envelope and converts attachment markdown', () => {
    const payload: MattermostPayload = {
      username: 'xrpld releases',
      icon_url: 'https://icon',
      attachments: [
        {
          fallback: 'fb',
          color: '#4CAF50',
          pretext: '**hi**',
          text: '[a](https://b)',
          footer: 'f',
          ts: 1,
        },
      ],
    }
    expect(toSlackPayload(payload)).toEqual({
      username: 'xrpld releases',
      icon_url: 'https://icon',
      attachments: [
        {
          fallback: 'fb',
          color: '#4CAF50',
          pretext: '*hi*',
          text: '<https://b|a>',
          footer: 'f',
          ts: 1,
          mrkdwn_in: ['text', 'pretext'],
        },
      ],
    })
  })
})

describe('mirrorToSlack', () => {
  it('is a no-op without a webhook URL', async () => {
    await mirrorToSlack(undefined, { text: 'x' })
    expect(axios.post).not.toHaveBeenCalled()
  })
  it('swallows post failures', async () => {
    ;(axios.post as jest.Mock).mockRejectedValue(new Error('boom'))
    await expect(
      mirrorToSlack('https://hooks.slack.com/services/x', { text: 'x' })
    ).resolves.toBeUndefined()
  })
})
