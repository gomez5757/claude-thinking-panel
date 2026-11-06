import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'razonamiento',
  component: 'Pane',
  requestId: 'razonamiento',
  props: {
    title: 'Razonamiento',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// Stands for the engine: one main-agent step that thinks one block, then the usage the banner reads.
function engine(on: any, edgeOk: boolean) {
  on('session.usage', () => ({ value: { context: { window: 200000 }, rateLimits: [] } }))
  on('ui.scroll', () => ({ value: {} }))
  mock.clock(on)
  on('http.fetch', () => ({
    value: edgeOk
      ? { status: 200, ok: true, headers: {}, text: JSON.stringify([{ translations: [{ text: 'Hola' }] }]) }
      : { status: 500, ok: false, headers: {}, text: '' },
  }))
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Hola', usage: { input_tokens: 1, output_tokens: 1 } } }))
  on('turn.step', async function* (_, e) {
    yield { kind: 'thinking', index: 0, text: 'Hello' }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null, id: 'm1' }
  })
}

for (const [edgeOk, via] of [
  [true, 'Edge'],
  [false, 'Haiku'],
] as const) {
  test(`the pane shows the ${via} translation with no label`, { options: { translateTo: 'Spanish', translator: 'edge' } }, async ($, on) => {
    engine(on as any, edgeOk)
    on('command.register', () => ({ value: { command: 'razonamiento' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }));
    // Let the unawaited translation settle.
    for (let i = 0; i < 20; i++) await Promise.resolve()

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ type: 'Markdown', text: /^Hola$/ }))?.text).toBe('Hola')
    expect(await ui.find({ type: 'Text', text: /traducido con/ })).toBeUndefined()
    await ui.unmount()
  })
}
