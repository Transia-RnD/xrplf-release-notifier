import { TwitterApi } from 'twitter-api-v2'

export interface TwitterCredentials {
  appKey: string
  appSecret: string
  accessToken: string
  accessSecret: string
}

export async function postToTwitter(
  credentials: TwitterCredentials,
  text: string
): Promise<void> {
  const client = new TwitterApi({
    appKey: credentials.appKey,
    appSecret: credentials.appSecret,
    accessToken: credentials.accessToken,
    accessSecret: credentials.accessSecret,
  })
  await client.v2.tweet(text)
}
