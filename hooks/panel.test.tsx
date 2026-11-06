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
