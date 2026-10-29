import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Block, Usage } from '../types'

const PANE = 'razonamiento'
const TITLE = 'Razonamiento'
const CODES: Record<string, string> = {
  Spanish: 'es',
  English: 'en',
  French: 'fr',
  German: 'de',
  Portuguese: 'pt',
  Italian: 'it',
  Chinese: 'zh-Hans',
  Japanese: 'ja',
}

// Edge's translatetext endpoint fails above ~15,000 characters per text, so send paragraphs in chunks of up to 10,000.
function chunks(text: string) {
  const out: string[] = []
  let cur = ''
  for (let para of text.split('\n\n')) {
    while (para.length > 10000) {
      if (cur) out.push(cur)
      cur = ''
      out.push(para.slice(0, 10000))
      para = para.slice(10000)
    }
    if (cur && cur.length + para.length + 2 > 10000) {
      out.push(cur)
      cur = para
    } else cur = cur ? `${cur}\n\n${para}` : para
  }
  if (cur) out.push(cur)
  return out
}

async function edge($: EngineInterface, lang: string, text: string) {
  const r = await $.http.fetch(
    `https://edge.microsoft.com/translate/translatetext?from=&to=${CODES[lang] ?? 'es'}&isEnterpriseClient=false`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chunks(text)),
    },
  )
  if (!r.ok) return undefined
  const parts: { translations: { text: string }[] }[] = JSON.parse(r.text)
  return parts.map(part => part.translations[0]?.text ?? '').join('\n\n')
}

// Edge first (free, no key); if it fails, Haiku at low effort through the person's own Claude session.
async function translate($: EngineInterface, translator: string, lang: string, text: string) {
  if (translator === 'edge') {
    const es = await edge($, lang, text).catch(() => undefined)
    if (es) return es
  }
  const r = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    system: `Translate the text you are given into ${lang}. Return only the translation, no comments. Do not translate code, paths or tool names.`,
    prompt: text,
  })
  return r.isAnswered ? r.text : undefined
}

const WEEK = 7 * 24 * 60 * 60 * 1000

// The banner shows the context in use: the last response's real input tokens against the window
// auto-compaction fires at (the app's Context panel measures against it too, but with estimated tokens).
// Then the weekly limit projected to its reset at the current pace.
// Both go to the banner at the foot of the pane.
async function measure($: EngineInterface) {
  const { context, rateLimits } = await $.session.usage({ breakdown: 'summary' })
  const now: Usage = {}
  const max = context.breakdown?.rawMaxTokens || context.window
  if (context.tokens !== undefined && max) now.ctx = Math.round((context.tokens / max) * 100)
  const week = rateLimits.find(limit => limit.kind === 'seven_day')
  if (week?.resetsAt) {
    const elapsed = WEEK - (Date.parse(week.resetsAt) - Date.now())
    if (elapsed > 60 * 60 * 1000) now.week = Math.round((week.percentUsed * WEEK) / elapsed)
  }
  await update($, usage, () => now)
}

// A compaction pressed while a turn runs waits here for turn.complete.
let isQueued = false

async function compact($: EngineInterface) {
  try {
    const { skip } = await $.session.compact()
    isQueued = false
    if (skip) $.ui.toast(`No se ha compactado: ${skip}`)
    else void measure($).catch(() => undefined)
  } catch (err) {
    if (isQueued) {
      isQueued = false
      $.ui.toast(`No se ha podido compactar: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    isQueued = true
    $.ui.toast('Se compactara al terminar el turno.')
  }
}

const blocks = atom({ plugin: 'razonamiento', key: 'blocks' } as const, [])
const usage = atom({ plugin: 'razonamiento', key: 'usage' } as const, {})

export const register: Register = (on, options) => {
  const lang = typeof options.translateTo === 'string' ? options.translateTo : 'off'
  const translator = options.translator === 'haiku' ? 'haiku' : 'edge'
  let lastPin = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'razonamiento',
      description: 'Abre el panel con el razonamiento de Claude',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void measure($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'razonamiento' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Panel de razonamiento abierto.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const prompt: Block = { id: `p-${Date.now()}`, who: 'tu', text: e.text, isDone: true, isPrompt: true }
    await update($, blocks, list => [...list, prompt].slice(-50))
    void $.ui.scroll({ in: PANE, to: 'end' })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const who = 'Claude'
    const texts = new Map<number, string>()
    let lastFlush = 0

    const flush = async (isDone: boolean) => {
      lastFlush = Date.now()
      const fresh: Block[] = [...texts].map(([index, text]) => ({
        id: `${e.turnId}-${e.index}-${index}`,
        who,
        text,
        isDone,
      }))
      await update($, blocks, list => {
        const ids = new Set(fresh.map(b => b.id))
        return [...list.filter(b => !ids.has(b.id)), ...fresh].slice(-50)
      })
      void $.ui.scroll({ in: PANE, to: 'end' })
    }

    const stream = next(e)
    for await (const chunk of stream) {
      // Only the main agent's thinking goes to the panel; subagents' is passed through untouched.
      if (chunk.kind === 'thinking' && !e.agentId) {
        texts.set(chunk.index, (texts.get(chunk.index) ?? '') + chunk.text)
        if (Date.now() - lastFlush > 300) await flush(false)
      }
      yield chunk
    }
    if (texts.size > 0) {
      await flush(true)
      if (lang !== 'off') for (const [index, text] of texts) {
        const id = `${e.turnId}-${e.index}-${index}`
        void translate($, translator, lang, text)
          .catch(() => undefined)
          .then(async es => {
            if (!es) return
            await update($, blocks, list => list.map(b => (b.id === id ? { ...b, es } : b)))
            void $.ui.scroll({ in: PANE, to: 'end' })
          })
      }
    }

    const result = await stream.result
    if (!e.agentId) void measure($).catch(() => undefined)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Compact once the turn has fully ended, not from inside its hook.
    if (isQueued && !e.agentId) void $.clock.sleep(1000).then(() => compact($))

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // Blocks saved by earlier versions may include subagents' thinking: leave it out.
    const all = (await read($, blocks)).filter(b => b.who !== 'subagente')
    // A pane drawn afresh (another chat opened, the app restarted) starts at the top: pin it to the end once drawn.
    if (Date.now() - lastPin > 2000) {
      lastPin = Date.now()
      void $.clock.sleep(150).then(() => $.ui.scroll({ in: PANE, to: 'end' }))
    }
    // The pane draws at most 100,000 characters, cut from the end, so keep the newest that fit.
    let room = 80000
    let start = all.length
    while (start > 0) {
      const b = all[start - 1]!
      room -= (b.es ?? b.text).length
      if (room < 0 && start < all.length) break
      start--
    }
    const list = all.slice(start)

    // The banner: the weekly projection and the context in use, in plain text.
    const { ctx, week } = await read($, usage)
    const facts = [week !== undefined && `Semana al ~${week}%`, ctx !== undefined && `contexto ${ctx}%`].filter(Boolean)

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>Sin razonamiento todavia.</Text>}
        {list.map(b =>
          b.isPrompt ? (
            <Box flexDirection="row" justifyContent="flex-end" marginTop={1} marginLeft={6}>
              <Box borderStyle="round" paddingX={1} flexShrink={1}>
                <Text>{b.text.length > 400 ? `${b.text.slice(0, 400)}...` : b.text}</Text>
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              {b.who !== 'Claude' && <Text bold>{b.who}</Text>}
              {!b.isDone && <Text bold>pensando...</Text>}
              <Text>{b.es ?? b.text}</Text>
            </Box>
          ),
        )}
        <Box flexDirection="row" alignItems="center" borderStyle="round" paddingX={1} marginTop={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text>
              {facts.join(' · ') || 'Sin datos de uso todavia'}
            </Text>
          </Box>
          <Button key="compactar" label="Compactar" onPress={() => compact($)} />
        </Box>
      </Box>
    )
  })
}
