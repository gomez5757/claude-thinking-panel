import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'razonamiento',
  component: 'Pane',
  requestId: 'razonamiento',
  props: { title: 'Razonamiento', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the pane shows what Claude did and turns the context red from 200k tokens', async ($, on) => {
  on('session.usage', () => ({ value: { context: { window: 1000000, tokens: 210000 }, rateLimits: [] } }))
  on('ui.scroll', () => ({ value: {} }))
  mock.clock(on)
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as any)
  on('command.register', () => ({ value: { command: 'razonamiento' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // A Windows path, its backslashes built here.
  await $.tool.call({ tool: 'Read', file_path: ['C:', 'Users', 'HP', 'x', 'register.tsx'].join(String.fromCharCode(92)) } as any)
  await $.tool.call({ tool: 'Bash', command: 'git status', description: 'Muestra el estado' } as any)
  await $.tool.call({ tool: 'Read', file_path: '/a/sub.ts', agentId: 'a1' } as any)
  for (let i = 0; i < 20; i++) await Promise.resolve()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^→ Lee register\.tsx$/ }))?.text).toBe('→ Lee register.tsx')
  expect((await ui.find({ type: 'Text', text: /^→ Ejecuta: Muestra el estado$/ }))).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sub\.ts/ })).toBeUndefined()
  // The banner's outer Text holds the red one, so look for the red run itself.
  const tree = JSON.stringify(await ui.find({}))
  expect(tree).toMatch(/"color":"error"[^}]*\},"children":\["Contexto 21% · 210k"\]/)
  await ui.unmount()
})

//#if full
test('/uso runs the web script with the limits and says so', async ($, on) => {
  on('session.usage', () => ({ value: { context: { window: 1000000, tokens: 1 }, rateLimits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: '2026-11-14T17:00:00Z' }] } }))
  on('ui.scroll', () => ({ value: {} }))
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'razonamiento' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const runs: string[][] = []
  on('process.run', (_, e: any) => (runs.push(e.argv ?? e.command ?? e), { value: { exitCode: 0, stdout: 'ok', stderr: '' } }) as any)
  const toasts: string[] = []
  on('ui.toast', (_, e: any) => (toasts.push(String(e.text ?? e)), { value: undefined }) as any)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.command.run({ command: 'uso' } as any)
  for (let i = 0; i < 200 && !toasts.length; i++) await Promise.resolve()
  expect(JSON.stringify(r)).toContain('navegador')
  expect(JSON.stringify(runs)).toContain('uso_web.py')
  expect(JSON.stringify(runs)).toContain('seven_day')
  expect(toasts.join()).toContain('abierta')
})

test('each change of the limits is kept in limites.json for the web', async ($, on) => {
  on('session.usage', () => ({ value: { context: { window: 1000000, tokens: 1 }, rateLimits: [{ kind: 'seven_day', percentUsed: 12, resetsAt: '2026-11-14T01:00:00Z' }] } }))
  on('ui.scroll', () => ({ value: {} }))
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'razonamiento' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', (_, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/x' : undefined }) as any)
  on('fs.read', () => { throw new Error('ENOENT') })
  const writes: { path: string; text: string }[] = []
  on('fs.write', (_, e: any) => (writes.push(e), { value: undefined }) as any)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 200 && !writes.length; i++) await Promise.resolve()
  expect(writes[0]?.path.split(String.fromCharCode(92)).join('/')).toBe('C:/Users/x/.claude/uso/limites.json')
  const log = JSON.parse(writes[0].text)
  expect(log[0].slice(1)).toEqual(['seven_day', 12, '2026-11-14T01:00:00Z'])
})
//#endif
