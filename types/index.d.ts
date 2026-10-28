export type Block = { id: string; who: string; text: string; isDone: boolean; es?: string; isPrompt?: boolean }
export type Usage = { ctx?: number; week?: number }

declare module 'claude-code' {
  interface PluginState {
    razonamiento: { blocks: Block[]; usage: Usage }
  }
}
