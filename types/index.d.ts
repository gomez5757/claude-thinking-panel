export type Block = { id: string; who: string; text: string; isDone: boolean; es?: string; isPrompt?: boolean }

declare module 'claude-code' {
  interface PluginState {
    razonamiento: { blocks: Block[] }
  }
}
