export type Block = { id: string; who: string; text: string; isDone: boolean; es?: string; via?: 'Edge' | 'Haiku'; isPrompt?: boolean; isAction?: boolean }
export type Limit = { kind: string; pct: number; resetsAt?: string }
export type Usage = { ctx?: number; week?: number; tokens?: number; limits?: Limit[] }
export type View = 'razon' | 'uso'
export type Spend = { cost: number; tokens: number }
// What scripts/uso.py prints; every field optional so a report from an older script still draws.
export type Report = {
  generated?: number
  pending?: number
  since?: number
  today?: Spend
  yesterday?: Spend
  week?: Spend
  month?: Spend
  w5?: Spend
  w7?: Spend
  daily?: { d: string; cost: number; opus: number }[]
  months?: { m: string; cost: number }[]
  models?: { model: string; cost: number; out: number; think: number }[]
  think?: { share: number; cost: number }
  cache?: number
  subShare?: number
  projects?: { name: string; cost: number }[]
  sessions?: { title: string; project: string; cost: number }[]
  prompts?: { text: string; ts: number; cost: number }[]
  tips?: { title: string; detail: string }[]
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    razonamiento: { blocks: Block[]; usage: Usage; view: View; report: Report; busy: boolean }
  }
}
