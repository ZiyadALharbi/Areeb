<p align="center">
  <img src="logo/areeb-header.png" alt="Areeb — a terminal coding agent inspired by Pi" width="100%" />
</p>

<p align="center">
  <strong>A sharp mind for your codebase.</strong>
</p>

<p align="center">
  <a href="https://areeb.dev/">Website</a>
  ·
  <a href="#install">Install</a>
  ·
  <a href="#quick-start">Quick start</a>
  ·
  <a href="https://www.npmjs.com/package/@ziyad_1440/areeb">npm</a>
</p>

---

## What is Areeb?

**Areeb is a coding agent that lives in your terminal.** Ask it to explain a
codebase, implement a feature, fix a bug, or run tests. Areeb can read files,
write and edit code, run shell commands, and preserve sessions so you can return
to your work later.

Areeb is also meant to be read. It is inspired by
[Pi](https://github.com/earendil-works/pi), and I built it as a learning project
to better understand how coding agents work. Its AI, agent, and coding layers
are kept separate so the provider interface, agent loop, tools, and application
can be explored independently.

```text
areeb_coding  →  areeb_agent  →  areeb_ai
```

- **`areeb_ai`**: turns model providers into one provider-neutral stream.
- **`areeb_agent`**: is the reusable brain: messages, tools, events, the agent
  loop, and session primitives.
- **`areeb_coding`**: turns that brain into a coding app: CLI, TUI, file and shell
  tools, provider configuration, project instructions, skills, and saved
  sessions.

The dependency direction stays simple: the coding layer uses the agent layer,
and the agent layer uses the AI layer. Each lower layer can be understood and
reused without pulling in the application above it.

## Install

Areeb is published on npm as [`@ziyad_1440/areeb`](https://www.npmjs.com/package/@ziyad_1440/areeb)
and installs an `areeb` command. It runs on [Bun](https://bun.sh/), so install
Bun first if it is not already available.

Install with Bun:

```bash
bun add --global @ziyad_1440/areeb
```

Or with npm:

```bash
npm install --global @ziyad_1440/areeb
```

Check that the command is available:

```bash
areeb --help
```

For local development:

```bash
git clone https://github.com/ZiyadALharbi/Areeb.git
cd Areeb
bun install
bun run src/coding/cli.ts --help
```

## Quick start

Run Areeb from the project you want it to work on:

```bash
cd my-project
areeb
```

Areeb needs access to a model provider. In the interactive interface, use
`/login` to connect an OpenAI API key or a ChatGPT Plus/Pro subscription, then
use `/model` to choose a model:

```text
/login
/model
```

You can also provide an OpenAI API key through the environment:

```bash
export OPENAI_API_KEY="your-api-key"
areeb
```

Then type a request and press **Enter**:

```text
explain what this project does
```

For scripts and quick tasks, use one-shot print mode:

```bash
areeb -p "summarize the architecture"
areeb -p "find the CLI entry point" --output json
```

## What Areeb can do

- Work interactively in a terminal UI or run a single prompt in print mode.
- Read files, write new files, make targeted edits, and run shell commands.
- Stream model output, reasoning, tool calls, and tool results as they happen.
- Save durable JSONL sessions under `~/.areeb/sessions/` and resume them later.
- Connect to OpenAI, ChatGPT Plus/Pro, and custom OpenAI-compatible endpoints.
- Switch providers, models, and reasoning effort from the CLI or terminal UI.
- Load project guidance from `AGENTS.md`, and `CLAUDE.md`.
- Discover reusable skills and prompt templates from user and project folders.
- Produce text, JSON, or transcript output for scripts and other tools.

## License

Areeb is released under the [MIT License](LICENSE).
