import axios from 'axios'

export interface MattermostAttachment {
  fallback: string
  color: string
  pretext?: string
  title?: string
  title_link?: string
  text?: string
  footer?: string
  ts?: number
}

export interface MattermostPayload {
  username?: string
  icon_url?: string
  text?: string
  attachments?: MattermostAttachment[]
}

export async function postToMattermost(
  webhookUrl: string,
  payload: MattermostPayload
): Promise<void> {
  const response = await axios.post(webhookUrl, payload)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Mattermost webhook failed with status ${response.status}`)
  }
}
