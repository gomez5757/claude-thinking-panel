# Claude Thinking Panel

A Claude Code mod that shows Claude's thinking live in a side panel next to the chat, instead of mixed into the conversation.

- Each of your prompts appears as a bubble on the right, with the thinking it triggered underneath, just like the chat.
- Thinking streams in as Claude writes it ("pensando..." while a block is still being written) and the panel scrolls to the newest text.
- Optional translation: each finished thinking block can be translated into the language you pick, for free by Microsoft Edge's translate endpoint, with Claude Haiku (low effort) as fallback. Off by default.
- Subagent thinking is shown too, labelled "subagente".

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
