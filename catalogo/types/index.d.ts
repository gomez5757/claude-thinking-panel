export type Block = { id: string; who: string; text: string; isDone: boolean; es?: string; via?: 'Edge' | 'Haiku'; isPrompt?: boolean; isAction?: boolean }
export type Usage = { ctx?: number; week?: number; tokens?: number }

declare module 'claude-code' {
  interface PluginState {
    razonamiento: { blocks: Block[]; usage: Usage }
  }
}
