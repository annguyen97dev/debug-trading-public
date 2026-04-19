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

type RedisProfile = 'pc' | 'demo' | 'bnb_demo' | 'bnb_staging'

type ProfileRuntime = {
  profile: RedisProfile
  redisUrl: string
  redisBlocking: Redis
  redisCommands: Redis
  clients: Set<SseClient>
  lastIds: Record<string, string>
}

function parseStreamKeys (): string[] {
  const raw = process.env.STREAM_KEYS ?? 'fill:price'
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function maskRedisUrl (url: string): string {
  return url.replace(/:[^:@]+@/, ':****@')
}

function parseProfileQuery (q: unknown): RedisProfile {
  if (typeof q !== 'string') return 'pc'
  const s = q.toLowerCase().replace(/-/g, '_')
  if (s === 'demo') return 'demo'
  if (s === 'bnb_demo') return 'bnb_demo'
  if (s === 'bnb_staging') return 'bnb_staging'
  return 'pc'
}

function envUrlForProfile (profile: RedisProfile): string | undefined {
  const raw =
    profile === 'pc'
      ? process.env.TPM_PC_REDIS_URL
      : profile === 'demo'
        ? process.env.TPM_DEMO_REDIS_URL
        : profile === 'bnb_demo'
          ? process.env.BNB_DEMO_REDIS_URL
          : process.env.BNB_STAGING_REDIS_URL
  const t = raw?.trim()
  return t === '' ? undefined : t
}

function profileEnvVarName (profile: RedisProfile): string {
  if (profile === 'pc') return 'TPM_PC_REDIS_URL'
  if (profile === 'demo') return 'TPM_DEMO_REDIS_URL'
  if (profile === 'bnb_demo') return 'BNB_DEMO_REDIS_URL'
  return 'BNB_STAGING_REDIS_URL'
}

function broadcast (
  clients: Set<SseClient>,
  payload: unknown
): void {
  const line = `data: ${JSON.stringify(payload)}\n\n`
  for (const c of clients) {
    c.res.write(line)
  }
}

async function runXreadLoop (
  rt: ProfileRuntime,
  streamKeys: string[],
  blockMs: number
): Promise<void> {
  const idsForXread = (): string[] =>
    streamKeys.map((k) => rt.lastIds[k] ?? '$')

  for (;;) {
    try {
      type XReadReply = [string, [string, string[]][]][] | null
      const raw = (await rt.redisBlocking.call(
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
          rt.lastIds[streamKey] = id
          const evt = buildStreamMessage(streamKey, id, fieldList)
          console.log(`[${rt.profile}]`, JSON.stringify(evt))
          broadcast(rt.clients, evt)
        }
      }
    } catch (e) {
      console.error(`[xread ${rt.profile}]`, e)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

async function run (): Promise<void> {
  const port = Number(process.env.PORT ?? 3847)
  const streamKeys = parseStreamKeys()
  const fromStart = process.env.FROM_START === '1' || process.env.FROM_START === 'true'
  const historyCount = ((): number => {
    const raw = process.env.HISTORY_COUNT
    if (raw === undefined || raw === '') return 20
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return 20
    return Math.min(500, Math.floor(n))
  })()

  const app = express()
  const redisOpts = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  } as const

  const profileOrder: RedisProfile[] = ['pc', 'demo', 'bnb_demo', 'bnb_staging']
  const runtimes = new Map<RedisProfile, ProfileRuntime>()

  for (const profile of profileOrder) {
    const redisUrl = envUrlForProfile(profile)
    if (redisUrl === undefined) continue

    const redisBlocking = new Redis(redisUrl, redisOpts)
    const redisCommands = redisBlocking.duplicate(redisOpts)

    const logRedisErr = (label: string) => (err: Error) => {
      console.error(`[redis ${profile} ${label}]`, err.message)
    }
    redisBlocking.on('error', logRedisErr('blocking'))
    redisCommands.on('error', logRedisErr('commands'))

    const lastIds: Record<string, string> = {}
    for (const key of streamKeys) {
      lastIds[key] = fromStart ? '0-0' : '$'
    }

    runtimes.set(profile, {
      profile,
      redisUrl,
      redisBlocking,
      redisCommands,
      clients: new Set<SseClient>(),
      lastIds
    })
  }

  const publicDir = path.join(process.cwd(), 'public')
  app.use(express.static(publicDir))

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      streams: streamKeys,
      profiles: {
        pc: envUrlForProfile('pc') !== undefined,
        demo: envUrlForProfile('demo') !== undefined,
        bnb_demo: envUrlForProfile('bnb_demo') !== undefined,
        bnb_staging: envUrlForProfile('bnb_staging') !== undefined
      }
    })
  })

  app.get('/api/events', (req, res) => {
    const profile = parseProfileQuery(req.query.profile)
    const rt = runtimes.get(profile)

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    if (rt === undefined) {
      const envName = profileEnvVarName(profile)
      res.write(
        `data: ${JSON.stringify({
          type: 'config_error',
          profile,
          message: `${envName} is not set or empty`
        })}\n\n`
      )
      res.end()
      return
    }

    const client: SseClient = { res }
    rt.clients.add(client)

    const hello = {
      type: 'connected',
      profile,
      streams: streamKeys,
      redisUrl: maskRedisUrl(rt.redisUrl),
      historyCount
    }
    res.write(`data: ${JSON.stringify(hello)}\n\n`)

    void (async () => {
      try {
        if (historyCount > 0) {
          const items = await fetchRecentAcrossStreams(
            rt.redisCommands,
            streamKeys,
            historyCount
          )
          res.write(
            `data: ${JSON.stringify({ type: 'history', items })}\n\n`
          )
        }
      } catch (e) {
        console.error(`[history ${profile}]`, e)
        res.write(
          `data: ${JSON.stringify({
            type: 'history_error',
            message: e instanceof Error ? e.message : String(e)
          })}\n\n`
        )
      }
    })()

    req.on('close', () => {
      rt.clients.delete(client)
    })
  })

  const blockMs = 30_000
  for (const rt of runtimes.values()) {
    void runXreadLoop(rt, streamKeys, blockMs)
  }

  app.listen(port, () => {
    console.log(`UI: http://127.0.0.1:${port}`)
    console.log(`Listening Redis streams: ${streamKeys.join(', ')}`)
    console.log(`FROM_START=${fromStart} (set FROM_START=1 to read from beginning)`)
    for (const p of profileOrder) {
      const u = envUrlForProfile(p)
      console.log(
        `Profile ${p}: ${u === undefined ? '(not configured)' : maskRedisUrl(u)}`
      )
    }
  })
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
