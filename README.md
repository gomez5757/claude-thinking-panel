# Claude Thinking Panel

A Claude Code mod that shows Claude's thinking live in a side panel next to the chat, instead of mixed into the conversation.

- Each of your prompts appears as a bubble on the right, with the thinking it triggered underneath, just like the chat.
- Thinking streams in as Claude writes it ("pensando..." while a block is still being written) and the panel follows the newest text while you are at the bottom. Scroll up to read and it stays put; scroll back to the end and it follows again.
- Optional translation: each finished thinking block can be translated into the language you pick, for free by Microsoft Edge's translate endpoint, with Claude Haiku (low effort) as fallback. Off by default.
- Between the thinking blocks, a dim line says what Claude did next ("→ Lee register.tsx", "→ Ejecuta: ...", "→ Busca en la web: ..."). Only the main agent's calls; the app's own bookkeeping tools are left out.
- Only the main agent's thinking is shown; subagents' thinking is left out.
- A banner at the foot of the pane shows the weekly limit projected to its reset (Uso), the context in use and its tokens (in red from 200k tokens, time to compact), with a Compactar button on the right that compacts the conversation like `/compact` (between turns only).
- `/uso` opens a web page in your browser about your usage. At the top, when your pace runs out the weekly and the 5-hour limits. Then what you spend at API prices with the month's forecast, the limits with their history, the last 24 hours by hour, what your plan is worth per month at API prices per model and how many times it returns what you pay, this month against the last, spending per day by model, projects, models, the hours you spend at, the most expensive conversations and prompts with a search box, and tips. Buttons pick the period and a list or a click on a project filters by project; a click on a day shows that day's conversations and prompts. `scripts/uso_web.py` builds it from the transcripts, kept in `~/.claude/uso/uso.db`, into `~/.claude/uso/uso.html`; the panel rebuilds it with the live limits after a turn, at most every 10 minutes, so it is ready without typing `/uso`, and the open page reloads itself. Opened on its own, it shows the last limits the panel saved.
- The panel keeps every change of your limits' percentages in `~/.claude/uso/limites.json`. The plan's worth per model comes from those readings against what was spent in the same window: until there are enough, every model is assumed to use the limit alike per API dollar.

The panel UI labels are in Spanish (the panel is titled "Razonamiento").

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install razonamiento --marketplace gomez5757/claude-thinking-panel
```

From a shell:

```bash
claude plugin install razonamiento --marketplace gomez5757/claude-thinking-panel
```

In the Claude desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `gomez5757/claude-thinking-panel`, then Add plugin.

Install it at the user scope to get the panel in every session. Sessions already open pick it up after a restart.

## Use

The panel opens by itself when a session starts. If you close it, run `/razonamiento` to open it again.

The panel only receives the thinking that Claude Code is set to show. In the desktop app, set the conversation's transcript view to "thinking" (title bar menu, or Ctrl+O). With the "normal" view the panel stays empty.

## Translation

Two options in the plugin's config:

- `translateTo`: off, Spanish, English, French, German, Portuguese, Italian, Chinese or Japanese. Default off.
- `translator`:
  - `edge` (default): Microsoft Edge's free translate endpoint (`edge.microsoft.com/translate/translatetext`). No key, no account, no usage. It is unofficial: Microsoft can change or stop it at any time, and your thinking text is sent to Microsoft. Long blocks are sent in chunks of up to 10,000 characters. If Edge fails, that block is translated by Claude Haiku instead.
  - `haiku`: always Claude Haiku at low effort, through your own Claude session. Good quality, uses a little of your subscription usage per block.

While a block is being written it shows as written; once the block ends it is replaced by the translation, usually within a second or two.

Or set them in `~/.claude/settings.json`:

```json
"pluginConfigs": {
  "razonamiento@claude-thinking-panel": {
    "options": { "translateTo": "Spanish", "translator": "edge" }
  }
}
```

## How it works

The mod hooks the model's response stream (`turn.step`), copies the thinking chunks into session state and draws them in a pane. It reads nothing from disk and sends nothing anywhere, except the optional translation request (to Microsoft with `edge`, or to your own Claude session with Haiku).

## License

MIT
