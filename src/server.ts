import 'dotenv/config'
import express from 'express'
import path from 'path'
import { Redis } from 'ioredis'

function parseFieldList (fields: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < fields.length; i += 2) {
    const k = fields[i]
    const v = fields[i + 1]
    if (k !== undefined && v !== undefined) out[k] = v
  }
  return out
}

/** Redis stream IDs sort by time; newer id compares greater. */
function compareStreamIdsDesc (a: string, b: string): number {
  const [a0, a1] = a.split('-')
  const [b0, b1] = b.split('-')
  const ta = Number(a0 ?? 0)
  const tb = Number(b0 ?? 0)
  if (tb !== ta) return tb - ta
  return Number(b1 ?? 0) - Number(a1 ?? 0)
}

function streamIdToIso (id: string): string {
  const ms = Number(id.split('-')[0])
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString()
}

function buildStreamMessage (
  streamKey: string,
  id: string,
  fieldList: string[]
): {
  type: 'stream_message'
  stream: string
  id: string
  fields: Record<string, string>
  data: unknown
  receivedAt: string
} {
  const fields = parseFieldList(fieldList)
  let parsed: unknown = fields.data ?? fields
  if (typeof fields.data === 'string') {
    try {
      parsed = JSON.parse(fields.data) as unknown
    } catch {
      parsed = fields.data
    }
  }
  return {
    type: 'stream_message',
    stream: streamKey,
    id,
    fields,
    data: parsed,
    receivedAt: streamIdToIso(id)
  }
}

type StreamMessageEvent = ReturnType<typeof buildStreamMessage>

async function fetchRecentAcrossStreams (
  redis: Redis,
  streamKeys: string[],
  count: number
): Promise<StreamMessageEvent[]> {
  const merged: StreamMessageEvent[] = []
  for (const streamKey of streamKeys) {
    type RevRow = [string, string[]]
    const rows = (await redis.xrevrange(
      streamKey,
      '+',
      '-',
      'COUNT',
      count
    )) as RevRow[]
    for (const [id, fieldList] of rows) {
      merged.push(buildStreamMessage(streamKey, id, fieldList))
    }
  }
  merged.sort((x, y) => compareStreamIdsDesc(x.id, y.id))
  return merged.slice(0, count)
}

type SseClient = { res: express.Response }

function parseStreamKeys (): string[] {
  const raw = process.env.STREAM_KEYS ?? 'fill:price'
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function broadcast (clients: Set<SseClient>, payload: unknown): void {
  const line = `data: ${JSON.stringify(payload)}\n\n`
  for (const c of clients) {
    c.res.write(line)
  }
}

async function run (): Promise<void> {
  const port = Number(process.env.PORT ?? 3847)
  const streamKeys = parseStreamKeys()
  const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
  const fromStart = process.env.FROM_START === '1' || process.env.FROM_START === 'true'
  const historyCount = ((): number => {
    const raw = process.env.HISTORY_COUNT
    if (raw === undefined || raw === '') return 20
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return 20
    return Math.min(500, Math.floor(n))
  })()

  const app = express()
  const clients = new Set<SseClient>()

  const reader = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  })

  reader.on('error', (err: Error) => {
    console.error('[redis]', err.message)
  })

  const publicDir = path.join(process.cwd(), 'public')
  app.use(express.static(publicDir))

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, streams: streamKeys })
  })

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const client: SseClient = { res }
    clients.add(client)

    const hello = {
      type: 'connected',
      streams: streamKeys,
      redisUrl: redisUrl.replace(/:[^:@]+@/, ':****@'),
      historyCount
    }
    res.write(`data: ${JSON.stringify(hello)}\n\n`)

    void (async () => {
      try {
        if (historyCount > 0) {
          const items = await fetchRecentAcrossStreams(
            reader,
            streamKeys,
            historyCount
          )
          res.write(
            `data: ${JSON.stringify({ type: 'history', items })}\n\n`
          )
        }
      } catch (e) {
        console.error('[history]', e)
        res.write(
          `data: ${JSON.stringify({
            type: 'history_error',
            message: e instanceof Error ? e.message : String(e)
          })}\n\n`
        )
      }
    })()

    req.on('close', () => {
      clients.delete(client)
    })
  })

  app.listen(port, () => {
    console.log(`UI: http://127.0.0.1:${port}`)
    console.log(`Listening Redis streams: ${streamKeys.join(', ')}`)
    console.log(`FROM_START=${fromStart} (set FROM_START=1 to read from beginning)`)
  })

  const lastIds: Record<string, string> = {}
  for (const key of streamKeys) {
    lastIds[key] = fromStart ? '0-0' : '$'
  }

  const blockMs = 30_000

  const idsForXread = (): string[] =>
    streamKeys.map((k) => lastIds[k] ?? '$')

  for (;;) {
    try {
      type XReadReply = [string, [string, string[]][]][] | null
      const raw = (await reader.call(
        'XREAD',
        'BLOCK',
        String(blockMs),
        'STREAMS',
        ...streamKeys,
        ...idsForXread()
      )) as XReadReply

      if (!raw) continue

      for (const [streamKey, entries] of raw) {
        for (const [id, fieldList] of entries) {
          lastIds[streamKey] = id
          const evt = buildStreamMessage(streamKey, id, fieldList)
          console.log(JSON.stringify(evt))
          broadcast(clients, evt)
        }
      }
    } catch (e) {
      console.error('[xread]', e)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
