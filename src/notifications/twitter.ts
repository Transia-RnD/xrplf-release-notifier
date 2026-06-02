import { TwitterApi } from 'twitter-api-v2'

export interface TwitterCredentials {
  appKey: string
  appSecret: string
  accessToken: string
  accessSecret: string
}

export interface TwitterMedia {
  buffer: Buffer
  mimeType: 'image/png' | 'image/jpeg'
}

/**
 * Tweet a status, optionally with one attached image.
 *
 * Twitter's tweet-create endpoint (v2) does not accept image bytes
 * directly — we first POST the buffer to v1.1 `media/upload`, get back
 * a `media_id`, and reference it on the v2 tweet. Both endpoints use
 * the same OAuth 1.0a user context from `credentials`.
 */
export async function postToTwitter(
  credentials: TwitterCredentials,
  text: string,
  media?: TwitterMedia
): Promise<void> {
  const client = new TwitterApi({
    appKey: credentials.appKey,
    appSecret: credentials.appSecret,
    accessToken: credentials.accessToken,
    accessSecret: credentials.accessSecret,
  })

  if (!media) {
    await client.v2.tweet(text)
    return
  }

  const mediaId = await client.v1.uploadMedia(media.buffer, {
    mimeType: media.mimeType,
  })
  await client.v2.tweet(text, { media: { media_ids: [mediaId] } })
}
