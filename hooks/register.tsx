import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Block, Limit, Report, Usage, View } from '../types'

const PANE = 'razonamiento'
const TITLE = 'Razonamiento'
// The pane's own background, under the rows that stay in place while the rest scrolls beneath them.
const BG = '#191919'
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
  now.limits = rateLimits.map(limit => ({ kind: limit.kind, pct: limit.percentUsed, resetsAt: limit.resetsAt }))
  await update($, usage, () => now)
}

// The Uso view: scripts/uso.py indexes the transcripts (only what is new since last time) and prints a report.
// One shot each time, nothing left running. A first index that does not fit in one call says what is pending,
// and runs again.
const HOUR = 60 * 60 * 1000
let running = false
let lastRefresh = 0
async function script($: EngineInterface, args: string[]) {
  const path = `${$.plugin.root}/scripts/uso.py`
  let failure: unknown
  for (const exe of ['python', 'py']) {
    try {
      return await $.process.run([exe, '-I', path, ...args], { timeoutMs: 180000 })
    } catch (err) {
      failure = err
    }
  }
  throw failure
}
async function refresh($: EngineInterface) {
  if (running) return
  running = true
  await update($, busy, () => true)
  try {
    await measure($).catch(() => undefined)
    const { limits } = await read($, usage)
    const args = ['--budget', '60']
    const five = limits?.find(l => l.kind === 'five_hour')
    const seven = limits?.find(l => l.kind === 'seven_day')
    if (five?.resetsAt) args.push('--w5', String(Date.parse(five.resetsAt) - 5 * HOUR))
    if (seven?.resetsAt) args.push('--w7', String(Date.parse(seven.resetsAt) - WEEK))
    for (let i = 0; i < 30; i++) {
      const r = await script($, args)
      if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `codigo ${r.exitCode}`)
      const rep: Report = JSON.parse(r.stdout)
      await update($, report, () => rep)
      if (!rep.pending) break
    }
    lastRefresh = Date.now()
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, report, r => ({ ...r, error }))
  } finally {
    running = false
    await update($, busy, () => false)
  }
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
const view = atom({ plugin: 'razonamiento', key: 'view' } as const, 'razon')
const report = atom({ plugin: 'razonamiento', key: 'report' } as const, {})
const busy = atom({ plugin: 'razonamiento', key: 'busy' } as const, false)

// Markdown takes tab and newline as its only control characters.
const clean = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

// Follow the newest text only while the person sits at the bottom; scrolling up stops it, back to the end resumes it.
// Only in the Razonamiento view: the Uso view reads from the top.
let follow = true
let mode: View = 'razon'
function pin($: EngineInterface) {
  if (follow && mode === 'razon') void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
}

async function show($: EngineInterface, next: View) {
  mode = next
  await update($, view, () => next)
  if (next === 'uso') {
    void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
    if (Date.now() - lastRefresh > 60000) void refresh($)
  } else {
    follow = true
    pin($)
  }
}

// Money as Spain writes it: 1.234 $ from 100 up, 12,34 $ below.
const money = (n = 0) =>
  n >= 100 ? `${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')} $` : `${n.toFixed(2).replace('.', ',')} $`
const DAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
const clock = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
const when = (iso: string, isWeek: boolean) => {
  const d = new Date(iso)
  return isWeek ? `el ${DAYS[d.getDay()]} a las ${clock(d)}` : `a las ${clock(d)}`
}

// One limit: how much is used, when it resets, where the current pace takes it, and what 1% costs.
function limitLine(l: Limit, span: number, spent?: number) {
  const name = l.kind === 'five_hour' ? '5 horas' : 'Semana'
  const pct = Math.round(l.pct)
  const parts = [`${name}: ${pct}%`]
  if (l.resetsAt) {
    parts.push(`se reinicia ${when(l.resetsAt, span === WEEK)}`)
    const elapsed = span - (Date.parse(l.resetsAt) - Date.now())
    if (elapsed > span / 10) parts.push(`a este ritmo llegas al ${Math.round((l.pct * span) / elapsed)}%`)
  }
  if (spent !== undefined && l.pct >= 1) parts.push(`1% ≈ ${money(spent / l.pct)}`)
  return { text: parts.join(' · '), isOver: !!l.resetsAt && l.pct * span / Math.max(1, span - (Date.parse(l.resetsAt) - Date.now())) > 100 }
}

// Bars as SVG for the surfaces that draw it; the darker part is Opus and Fable.
function bars(values: { label: string; total: number; dark?: number }[], unit: string) {
  const w = 320
  const h = 96
  const max = Math.max(...values.map(v => v.total), 0.01)
  const step = w / values.length
  const rects = values
    .map((v, i) => {
      const x = (i * step + 1).toFixed(1)
      const bw = Math.max(1, step - 2).toFixed(1)
      const th = (v.total / max) * (h - 26)
      const dh = ((v.dark ?? 0) / max) * (h - 26)
      return `<rect x="${x}" y="${(h - 14 - th).toFixed(1)}" width="${bw}" height="${th.toFixed(1)}" fill="#8fa6c9"/>` +
        `<rect x="${x}" y="${(h - 14 - dh).toFixed(1)}" width="${bw}" height="${dh.toFixed(1)}" fill="#d97757"/>`
    })
    .join('')
  const first = values[0]?.label ?? ''
  const last = values[values.length - 1]?.label ?? ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<text x="0" y="9" font-size="9" fill="#888">max ${money(max)}${unit}</text>${rects}` +
    `<text x="0" y="${h - 2}" font-size="9" fill="#888">${first}</text>` +
    `<text x="${w}" y="${h - 2}" font-size="9" fill="#888" text-anchor="end">${last}</text></svg>`
}

// The same bars in text, for the terminal.
const spark = (values: number[]) => {
  const max = Math.max(...values, 0.01)
  return values.map(v => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((v / max) * 7.99))]).join('')
}

const lastDays = (daily: Report['daily'] = []) => {
  const byDay = new Map(daily.map(d => [d.d, d]))
  const out = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const v = byDay.get(key)
    out.push({ label: `${d.getDate()}/${d.getMonth() + 1}`, total: v?.cost ?? 0, dark: v?.opus ?? 0 })
  }
  return out
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
    mode = await read($, view)
    // Once per session: index what is new, so the history keeps what the 30-day cleanup deletes.
    void refresh($)

    return next(e)
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
    if (!e.agentId && mode === 'uso' && Date.now() - lastRefresh > 60000) void refresh($)

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
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    mode = await read($, view)

    // The pane has no fixed rows of its own, so the switch and the banner are laid over the body
    // at the rows in view, and drawn again wherever the person scrolls.
    const { offset, bodyRows } = e.props.scroll
    const BANNER = 3
    const frame = (body: any, banner: any) => (
      <Box flexDirection="column" minHeight={bodyRows} paddingTop={2} paddingBottom={BANNER + 1}>
        {body}
        <Box position="absolute" top={offset} left={0} right={0} backgroundColor={BG} flexDirection="row" paddingBottom={1}>
          <Button key="ver-razon" label="Texto" variant={mode === 'razon' ? 'primary' : 'secondary'} onPress={() => void show($, 'razon')} />
          <Box marginLeft={1}>
            <Button key="ver-uso" label="Uso" variant={mode === 'uso' ? 'primary' : 'secondary'} onPress={() => void show($, 'uso')} />
          </Box>
        </Box>
        <Box position="absolute" top={Math.max(0, offset + bodyRows - BANNER)} left={0} right={0} backgroundColor={BG}>
          {banner}
        </Box>
      </Box>
    )

    // The banner: the weekly projection and the context in use, in plain text.
    const { ctx, week, tokens, limits } = await read($, usage)
    const used = [
      ctx !== undefined && `Contexto ${ctx}%`,
      tokens !== undefined && `${Math.round(tokens / 1000)}k`,
    ].filter(Boolean).join(' · ')
    // From 200k tokens in use the context goes red: time to compact.
    const isFull = tokens !== undefined && tokens >= 200000
    const banner = (
      <Box flexDirection="row" alignItems="center" borderStyle="round" paddingX={1} flexGrow={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            {week === undefined && !used && 'Sin datos de uso todavia'}
            {week !== undefined && `Uso ${week}%${used ? ' · ' : ''}`}
            {used && <Text color={isFull ? 'error' : undefined} bold={isFull}>{used}</Text>}
          </Text>
        </Box>
        <Button key="compactar" label="Compactar" onPress={() => compact($)} />
      </Box>
    )

    if (mode === 'uso') {
      const r = await read($, report)
      const isBusy = await read($, busy)
      const five = limits?.find(l => l.kind === 'five_hour')
      const seven = limits?.find(l => l.kind === 'seven_day')
      const lines = [
        five && limitLine(five, 5 * HOUR, r.w5?.cost),
        seven && limitLine(seven, WEEK, r.w7?.cost),
      ].filter(Boolean) as { text: string; isOver: boolean }[]
      const days = lastDays(r.daily)
      const months = (r.months ?? []).map(m => ({ label: m.m.slice(2).replace('-', '/'), total: m.cost }))
      const table = (head: string, rows: string[][]) =>
        rows.length ? `| ${head} |\n|${head.split('|').map(() => '---').join('|')}|\n${rows.map(c => `| ${c.join(' | ')} |`).join('\n')}` : ''
      const monthTotal = r.month?.cost || 1
      const md = [
        `**Gasto** (a precio de la API)\n\nHoy ${money(r.today?.cost)} · Ayer ${money(r.yesterday?.cost)} · 7 dias ${money(r.week?.cost)} · Este mes ${money(r.month?.cost)}`,
      ]
      const md2 = [
        r.models?.length && `**Modelos este mes**\n\n${table('Modelo | Gasto | %', r.models.map(m => [m.model, money(m.cost), `${Math.round((100 * m.cost) / monthTotal)}%`]))}`,
        r.think && `**Razonamiento**: el ${r.think.share}% de lo que escribe Claude este mes, unos ${money(r.think.cost)}.`,
        r.cache !== undefined && `**Memoria intermedia** aprovechada esta semana: ${r.cache}%. **Ayudantes**: ${r.subShare ?? 0}% del gasto de la semana.`,
        r.projects?.length && `**Proyectos, 30 dias**\n\n${table('Proyecto | Gasto', r.projects.map(p => [p.name.replace(/\|/g, '/'), money(p.cost)]))}`,
        r.sessions?.length && `**Conversaciones mas caras, 7 dias**\n\n${r.sessions.map(s => `- ${money(s.cost)} · ${s.title.replace(/\n/g, ' ')} (${s.project})`).join('\n')}`,
        r.prompts?.length && `**Peticiones mas caras, 7 dias**\n\n${r.prompts.map(p => `- ${money(p.cost)} · ${cut(p.text, 90)}`).join('\n')}`,
        `**Consejos**\n\n${r.tips?.length ? r.tips.map(t => `- **${t.title}.** ${t.detail}`).join('\n') : 'Nada que mejorar esta semana.'}`,
      ].filter(Boolean) as string[]
      const status = isBusy
        ? r.pending ? `Leyendo registros, faltan ${r.pending} archivos...` : 'Actualizando...'
        : r.generated ? `Actualizado a las ${clock(new Date(r.generated))}${r.since ? ` · datos desde ${new Date(r.since).toLocaleDateString('es-ES')}` : ''}` : 'Sin datos todavia'

      return (
        frame(<Box flexDirection="column">
          <Text bold>Limites</Text>
          {lines.length === 0 && <Text dimColor>Aparecen tras la primera respuesta de la sesion.</Text>}
          {lines.map(l => <Text color={l.isOver ? 'error' : undefined}>{l.text}</Text>)}
          {r.generated !== undefined && (
            <Box flexDirection="column" marginTop={1}>
              <Markdown text={md.join('\n\n')} />
              <Box marginTop={1} flexDirection="column">
                <Text bold>Ultimos 30 dias</Text>
                {'Svg' in ui
                  ? <ui.Svg source={bars(days, '')} alt={`Gasto diario de los ultimos 30 dias: ${days.map(d => `${d.label} ${money(d.total)}`).join(', ')}`} />
                  : <Text>{spark(days.map(d => d.total))}</Text>}
                {months.length > 1 && <Text bold>Por meses</Text>}
                {months.length > 1 && ('Svg' in ui
                  ? <ui.Svg source={bars(months, '')} alt={`Gasto por meses: ${months.map(m => `${m.label} ${money(m.total)}`).join(', ')}`} />
                  : <Text>{spark(months.map(m => m.total))}</Text>)}
                <Text dimColor>Naranja: Opus y Fable. Azul: el resto.</Text>
              </Box>
              <Box marginTop={1}>
                <Markdown text={md2.join('\n\n')} />
              </Box>
            </Box>
          )}
          {r.error && <Text color="error">{`No se ha podido leer el uso: ${r.error}`}</Text>}
          <Box flexDirection="row" alignItems="center" marginTop={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor wrap="truncate-end">{status}</Text>
            </Box>
            <Button key="actualizar" label="Actualizar" onPress={() => void refresh($)} />
          </Box>

        </Box>, banner)
      )
    }

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

    return (
      frame(<Box flexDirection="column">
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

      </Box>, banner)
    )
  })
}
