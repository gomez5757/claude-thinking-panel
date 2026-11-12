# Razonamiento

A Claude Code plugin that shows Claude's thinking live in a side panel next to the chat, instead of mixed into the conversation.

- Each of your prompts appears as a bubble on the right, with the thinking it triggered underneath.
- Thinking streams in as Claude writes it ("pensando..." while a block is still being written). The panel follows the newest text while you are at the bottom; scroll up to read and it stays put.
- Between the thinking blocks, a dim line says what Claude did next ("→ Lee register.tsx", "→ Ejecuta: ..."). Only the main agent's thinking and calls are shown.
- A banner at the foot of the panel shows your weekly limit projected to its reset at the current pace, and the context in use with its tokens, in red from 200k tokens. Its Compactar button compacts the conversation like `/compact`.
- Optional translation of each finished thinking block into Spanish, English, French, German, Portuguese, Italian, Chinese or Japanese. Off by default.

The panel's labels are in Spanish; the panel is titled "Razonamiento".

## Where it works

Claude Code: the desktop app and the terminal. The panel is part of Claude Code's interface, so it shows nothing on claude.ai or in Cowork.

## Use

The panel opens by itself when a session starts. If you close it, run `/razonamiento` to open it again.

The panel only receives the thinking that Claude Code is set to show. In the desktop app, set the conversation's transcript view to "thinking" (title bar menu, or Ctrl+O). With the "normal" view the panel stays empty.

## Commands it runs and hooks it adds

- It runs `/compact` only when you press the Compactar button in the panel's banner, and at no other time. The engine queues it until Claude is idle.
- It adds the `/razonamiento` command and answers it by opening the panel. It does nothing else when that command runs.

## Translation

Set `translateTo` in the plugin's options. Each finished block is translated by Claude Haiku at low effort through your own Claude session, which uses a little of your plan's usage per block. While a block is being written it shows as written; once it ends it is replaced by the translation.

## Privacy

The plugin reads the thinking and your prompts as they stream in the current session, and the context and limit figures Claude Code gives it. It keeps them in the session's state only, writes no files of its own and sends nothing outside your own Claude session.

## License

MIT
