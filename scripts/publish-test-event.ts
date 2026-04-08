import 'dotenv/config'
import { Redis } from 'ioredis'

/**
 * Publishes one test message using the same shape as the trading engine:
 * xadd(stream, 'MAXLEN', '~', 500, '*', 'data', jsonPayload)
 */
async function main (): Promise<void> {
  const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
  const stream =
    process.env.STREAM_KEYS?.split(',')[0]?.trim() ?? 'fill:price'

  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null })

  const payload = {
    marketId: 'test-market-' + Date.now(),
    outcomeId: 'outcome-a',
    fillPrice: '0.42',
    timestamp: new Date().toISOString(),
    source: 'publish-test-event script'
  }

  const id = await redis.xadd(
    stream,
    'MAXLEN',
    '~',
    500,
    '*',
    'data',
    JSON.stringify(payload)
  )

  console.log('xadd ok', { stream, id, payload })
  await redis.quit()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
