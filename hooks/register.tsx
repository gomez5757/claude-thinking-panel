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
  await record($, rateLimits).catch(() => undefined)
}

// The limits' percentages exist only here, reading by reading; nothing else keeps them. Each change goes to
// ~/.claude/uso/limites.json, so the usage web can work out what a full limit is worth per model.
let lastSeen = ''
async function usoDir($: EngineInterface) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? `${home}/.claude/uso` : undefined
}
async function record($: EngineInterface, limits: { kind: string; percentUsed: number; resetsAt?: string }[]) {
  const seen = limits.map(l => `${l.kind}|${l.percentUsed}|${l.resetsAt ?? ''}`).join(',')
  if (!limits.length || seen === lastSeen) return
  lastSeen = seen
  const dir = await usoDir($)
  if (!dir) return
  const path = `${dir}/limites.json`
  // Read again before each write: other sessions add to the same file.
  const log: [number, string, number, string][] = await $.fs.read(path).then(t => JSON.parse(t as string), () => [])
  const t = Date.now()
  for (const l of limits) {
    const prev = [...log].reverse().find(x => x[1] === l.kind)
    if (!prev || prev[2] !== l.percentUsed || prev[3] !== (l.resetsAt ?? '')) log.push([t, l.kind, l.percentUsed, l.resetsAt ?? ''])
  }
  await $.fs.write(path, JSON.stringify(log.slice(-50000)))
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

// Markdown takes tab and newline as its only control characters.
const clean = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

// Follow the newest text only while the person sits at the bottom; scrolling up stops it, back to the end resumes it.
let follow = true
function pin($: EngineInterface) {
  if (follow) void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
}
// The window counts rows from the top, so dropping old blocks above it slides the text under the reader.
// While the person reads, keep the first drawn block in place and trim nothing; trim again once they follow.
let anchor: string | undefined
const keep = (list: Block[]) => list.slice(follow ? -120 : -400)

const name = (path: unknown) => String(path ?? '').split(/[\\/]/).pop()
const cut = (text: unknown, n = 60) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}...` : t
}

// One short line saying what a tool call does, in Spanish; undefined for the app's own bookkeeping tools.
function action(e: Record<string, unknown> & { tool: string }) {
  const t = e.tool
  if (/^mcp__ccd_|^ToolSearch$|^TodoWrite$|^Task(Create|Update|List|Get)$/.test(t)) return undefined
  if (t === 'Read') return `Lee ${name(e.file_path)}`
  if (t === 'Edit' || t === 'MultiEdit') return `Edita ${name(e.file_path)}`
  if (t === 'Write') return `Escribe ${name(e.file_path)}`
  if (t === 'Bash' || t === 'PowerShell') return `Ejecuta: ${cut(e.description || e.command)}`
  if (t === 'Grep' || t === 'Glob') return `Busca ${cut(e.pattern, 40)}`
  if (t === 'Agent') return `Lanza un ayudante: ${cut(e.description)}`
  if (t === 'Skill') return `Usa la habilidad ${cut(e.skill, 40)}`
  if (typeof e.url === 'string') return `Abre ${cut(e.url)}`
  if (typeof e.query === 'string' || /search/i.test(t)) return `Busca en la web: ${cut(e.query ?? e.objective)}`
  return `Usa ${t.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')}`
}

async function web($: EngineInterface, quiet = false) {
  try {
    const { rateLimits } = await $.session.usage({ breakdown: 'summary' })
    const limits = JSON.stringify(rateLimits.map(l => ({ kind: l.kind, pct: l.percentUsed, resetsAt: l.resetsAt })))
    const path = `${$.plugin.root}/scripts/uso_web.py`
    let r
    for (const exe of ['python', 'py']) {
      try {
        r = await $.process.run([exe, '-I', path, '--limits', limits, ...(quiet ? ['--no-open'] : [])], { timeoutMs: 600000 })
        break
      } catch {
        // Try the next Python launcher.
      }
    }
    if (!r) throw new Error('no encuentro Python')
    if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `codigo ${r.exitCode}`)
    if (!quiet) $.ui.toast('Web de uso abierta en el navegador.')
  } catch (err) {
    if (!quiet) $.ui.toast(`No se ha podido abrir la web de uso: ${err instanceof Error ? err.message : String(err)}`)
  }
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
    await $.command.register({
      name: 'uso',
      description: 'Abre en el navegador una web con tus limites, tu gasto y consejos',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void measure($).catch(() => undefined)

    return next(e)
  })

  // /uso: scripts/uso_web.py reads the transcripts, writes a web page and opens it in the browser.
  // The limits only exist here, in the engine, so they go to the script as an argument.
  on('command.run', { command: 'uso' }, async $ => {
    void web($)

    return { text: 'Preparando la web de uso, se abrira en tu navegador.' }
  })

  // The web is rebuilt with the live limits after a turn, at most every 10 minutes, and the open page reloads itself.
  let lastWeb = 0
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (Date.now() - lastWeb > 10 * 60 * 1000) {
      lastWeb = Date.now()
      void web($, true)
    }
    return result
  })

  on('command.run', { command: 'razonamiento' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Panel de razonamiento abierto.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const prompt: Block = { id: `p-${Date.now()}`, who: 'tu', text: e.text, isDone: true, isPrompt: true }
    await update($, blocks, list => keep([...list, prompt]))
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
        const byId = new Map(fresh.map(b => [b.id, b]))
        const kept = list.map(b => byId.get(b.id) ?? b)
        const known = new Set(list.map(b => b.id))
        return keep([...kept, ...fresh.filter(b => !known.has(b.id))])
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

  // A line per tool call of the main agent, between the thinking blocks, so the panel shows what each thought led to.
  on('tool.call', ($, e, next) => {
    const text = e.agentId ? undefined : action(e as any)
    if (text) {
      const line: Block = { id: `a-${e.tool_use_id ?? Date.now()}`, who: 'Claude', text, isDone: true, isAction: true }
      void update($, blocks, list => keep([...list, line]))
        .then(() => pin($))
        .catch(() => undefined)
    }
    return next(e)
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, ($, e, next) => {
    if (e.origin.kind === 'person') {
      const was = follow
      follow = e.offset >= e.contentRows - e.bodyRows - 1
      // Back at the end of a held window: redraw with the newest blocks and pin to the end.
      if (follow && !was) {
        lastPin = 0
        $.ui.invalidate('ui.render')
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    // Blocks saved by earlier versions may include subagents' thinking: leave it out.
    const all = (await read($, blocks)).filter(b => b.who !== 'subagente')
    // A pane drawn afresh (another chat opened, the app restarted) starts at the top: pin it to the end once drawn.
    if (follow && Date.now() - lastPin > 2000) {
      lastPin = Date.now()
      void $.clock.sleep(150).then(() => $.ui.scroll({ in: PANE, to: 'end' })).catch(() => undefined)
    }
    // The pane draws at most 100,000 characters, cut from the end, so keep the newest that fit.
    // Following: the newest that fit. Reading: from the held first block forward, so nothing above moves.
    let room = 80000
    let start = all.length
    let end = all.length
    const held = follow ? -1 : all.findIndex(b => b.id === anchor)
    if (held >= 0) {
      start = end = held
      while (end < all.length) {
        room -= (all[end]!.es ?? all[end]!.text).length
        if (room < 0 && end > start) break
        end++
      }
    } else {
      while (start > 0) {
        const b = all[start - 1]!
        room -= (b.es ?? b.text).length
        if (room < 0 && start < all.length) break
        start--
      }
    }
    const list = all.slice(start, end)
    anchor = list[0]?.id

    // The banner: the weekly projection and the context in use, in plain text.
    const { ctx, week, tokens } = await read($, usage)
    const used = [
      ctx !== undefined && `Contexto ${ctx}%`,
      tokens !== undefined && `${Math.round(tokens / 1000)}k`,
    ].filter(Boolean).join(' · ')
    // From 200k tokens in use the context goes red: time to compact.
    const isFull = tokens !== undefined && tokens >= 200000

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>Sin razonamiento todavia.</Text>}
        {list.map(b =>
          b.isAction ? (
            <Text dimColor>{`→ ${b.text}`}</Text>
          ) : b.isPrompt ? (
            <Box flexDirection="row" justifyContent="flex-end" marginTop={1} marginLeft={6}>
              <Box borderStyle="round" paddingX={1} flexShrink={1}>
                <Text>{b.text.length > 400 ? `${b.text.slice(0, 400)}...` : b.text}</Text>
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              {b.who !== 'Claude' && <Text bold>{b.who}</Text>}
              {!b.isDone && <Text bold>pensando...</Text>}
              <Markdown text={clean(b.es ?? b.text)} />
            </Box>
          ),
        )}
        <Box flexDirection="row" alignItems="center" borderStyle="round" paddingX={1} marginTop={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              {week === undefined && !used && 'Sin datos de uso todavia'}
              {week !== undefined && `Uso ${week}%${used ? ' · ' : ''}`}
              {used && <Text color={isFull ? 'error' : undefined} bold={isFull}>{used}</Text>}
            </Text>
          </Box>
          <Button key="compactar" label="Compactar" onPress={() => compact($)} />
        </Box>
      </Box>
    )
  })
}
