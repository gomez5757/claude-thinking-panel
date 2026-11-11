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
  // The switch is laid at the top row in view and the banner at the last three (40 rows, scrolled to 0).
  expect(tree).toContain('"top":0')
  expect(tree).toContain('"top":37')
  await ui.unmount()
})

test('the switch shows the Uso view with the limits, the spending and the chart', async ($, on) => {
  const resets = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString()
  on('session.usage', () => ({ value: { context: { window: 1000000, tokens: 50000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: resets }] } }))
  on('ui.scroll', () => ({ value: {} }))
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'razonamiento' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const rep = {
    generated: Date.now(), pending: 0, today: { cost: 12.34, tokens: 1 }, month: { cost: 1717, tokens: 1 }, w7: { cost: 400, tokens: 1 },
    daily: [{ d: '2026-11-10', cost: 50, opus: 40 }], months: [{ m: '2026-10', cost: 5336 }, { m: '2026-11', cost: 1717 }],
    tips: [{ title: 'Un consejo', detail: 'Detalle.' }],
  }
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(rep), stderr: '' } }) as any)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 20; i++) await Promise.resolve()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The switch at the top: Texto and Uso, no other usage button.
  expect(await ui.find({ key: 'ver-razon' })).toBeDefined()
  expect(await ui.find({ key: 'volver-razon' })).toBeUndefined()
  await ui.press({ key: 'ver-uso' })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect((await ui.find({ type: 'Text', text: /^Semana: 40%/ }))?.text).toMatch(/1% ≈ 10,00 \$/)
  const tree = JSON.stringify(await ui.find({}))
  expect(tree).toContain('Hoy 12,34 $')
  expect(tree).toContain('Este mes 1.717 $')
  expect(tree).toContain('<svg')
  expect(tree).toContain('Un consejo')
  // Back to the thinking text.
  await ui.press({ key: 'ver-razon' })
  expect(await ui.find({ type: 'Text', text: /^Semana:/ })).toBeUndefined()
  await ui.unmount()
})
