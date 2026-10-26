import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Block } from '../types'

const PANE = 'razonamiento'
const CODES: Record<string, string> = {
  Spanish: 'es',
  English: 'en',
  French: 'fr',
  German: 'de',
  Portuguese: 'pt',
  Italian: 'it',
  Chinese: 'zh-CN',
  Japanese: 'ja',
}
async function translate($: EngineInterface, translator: string, lang: string, text: string) {
  if (translator === 'google-free') {
    const r = await $.http.fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${CODES[lang] ?? 'es'}&dt=t`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `q=${encodeURIComponent(text)}`,
      },
    )
    if (!r.ok) return undefined
    const parts: [string][] = JSON.parse(r.text)[0] ?? []
    return parts.map(part => part[0]).join('')
  }
  const r = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    system: `Translate the text you are given into ${lang}. Return only the translation, no comments. Do not translate code, paths or tool names.`,
    prompt: text,
  })
  return r.isAnswered ? r.text : undefined
}

// The pane's title carries the share of the context window in use, once the session has a reading.
async function title($: EngineInterface) {
  const { context } = await $.session.usage()
  return context.percent === undefined ? 'Razonamiento' : `Razonamiento - ${context.percent}% contexto`
}

// Retitle the pane in place, without reopening it if the person closed it.
async function retitle($: EngineInterface) {
  if (!(await $.ui.panes()).some(pane => pane.id === PANE)) return
  await $.ui.open({ id: PANE, title: await title($) })
}

const blocks = atom({ plugin: 'razonamiento', key: 'blocks' } as const, [])

export const register: Register = (on, options) => {
  const lang = typeof options.translateTo === 'string' ? options.translateTo : 'off'
  const translator = options.translator === 'google-free' ? 'google-free' : 'haiku'
  let lastPin = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'razonamiento',
      description: 'Abre el panel con el razonamiento de Claude',
    })
    void title($).then(t => $.ui.open({ id: PANE, title: t }))

    return next(e)
  })

  on('command.run', { command: 'razonamiento' }, async $ => {
    await $.ui.open({ id: PANE, title: await title($) })

    return { text: 'Panel de razonamiento abierto.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const prompt: Block = { id: `p-${Date.now()}`, who: 'tu', text: e.text, isDone: true, isPrompt: true }
    await update($, blocks, list => [...list, prompt].slice(-50))
    void $.ui.scroll({ in: PANE, to: 'end' })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const who = e.agentId ? 'subagente' : 'Claude'
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
      if (chunk.kind === 'thinking') {
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
    if (!e.agentId) void retitle($).catch(() => undefined)

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const all = await read($, blocks)
    // A pane drawn afresh (another chat opened, the app restarted) starts at the top: pin it to the end once drawn.
    if (Date.now() - lastPin > 2000) {
      lastPin = Date.now()
      void $.clock.sleep(150).then(() => $.ui.scroll({ in: PANE, to: 'end' }))
    }
    // The pane draws at most 100,000 characters, cut from the end, so keep the newest that fit.
    let room = 80000
    let start = all.length
    while (start > 0) {
      const b = all[start - 1]
      room -= (b.es ?? b.text).length
      if (room < 0 && start < all.length) break
      start--
    }
    const list = all.slice(start)

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
      </Box>
    )
  })
}
