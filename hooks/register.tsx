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
// Answers which engine translated it, so the pane can show it.
async function translate($: EngineInterface, translator: string, lang: string, text: string) {
  if (translator === 'edge') {
    const es = await edge($, lang, text).catch(() => undefined)
    if (es) return { es, via: 'Edge' as const }
  }
  const r = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    system: `Translate the text you are given into ${lang}. Return only the translation, no comments. Do not translate code, paths or tool names.`,
    prompt: text,
  })
  return r.isAnswered ? { es: r.text, via: 'Haiku' as const } : undefined
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
  if (context.tokens !== undefined) now.tokens = context.tokens
  const week = rateLimits.find(limit => limit.kind === 'seven_day')
  if (week?.resetsAt) {
    const elapsed = WEEK - (Date.parse(week.resetsAt) - Date.now())
    if (elapsed > 60 * 60 * 1000) now.week = Math.round((week.percentUsed * WEEK) / elapsed)
  }
  await update($, usage, () => now)
}

// Runs /compact as if the person typed it: the engine queues it until the session is idle,
// so a press during a turn waits instead of failing.
async function compact($: EngineInterface) {
  try {
    await $.command.run({ command: 'compact' })
    void measure($).catch(() => undefined)
  } catch (err) {
    $.ui.toast(`No se ha podido compactar: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const blocks = atom({ plugin: 'razonamiento', key: 'blocks' } as const, [])
const usage = atom({ plugin: 'razonamiento', key: 'usage' } as const, {})

// Follow the newest text only while the person sits at the bottom; scrolling up stops it, back to the end resumes it.
let follow = true
function pin($: EngineInterface) {
  if (follow) void $.ui.scroll({ in: PANE, to: 'end' })
}

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
    pin($)

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
      pin($)
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
          .then(async done => {
            if (!done) return
            await update($, blocks, list => list.map(b => (b.id === id ? { ...b, ...done } : b)))
            pin($)
          })
      }
    }

    const result = await stream.result
    if (!e.agentId) void measure($).catch(() => undefined)

    return result
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, ($, e, next) => {
    if (e.origin.kind === 'person') follow = e.offset >= e.contentRows - e.bodyRows - 1
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // Blocks saved by earlier versions may include subagents' thinking: leave it out.
    const all = (await read($, blocks)).filter(b => b.who !== 'subagente')
    // A pane drawn afresh (another chat opened, the app restarted) starts at the top: pin it to the end once drawn.
    if (follow && Date.now() - lastPin > 2000) {
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
    const { ctx, week, tokens } = await read($, usage)
    const facts = [
      week !== undefined && `Uso ${week}%`,
      ctx !== undefined && `Contexto ${ctx}%`,
      tokens !== undefined && `${Math.round(tokens / 1000)}k`,
    ].filter(Boolean)

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
              {b.via && <Text dimColor>traducido con {b.via}</Text>}
            </Box>
          ),
        )}
        <Box flexDirection="row" alignItems="center" borderStyle="round" paddingX={1} marginTop={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              {facts.join(' · ') || 'Sin datos de uso todavia'}
            </Text>
          </Box>
          <Button key="compactar" label="Compactar" onPress={() => compact($)} />
        </Box>
      </Box>
    )
  })
}
