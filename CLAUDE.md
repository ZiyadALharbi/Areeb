# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Ensure high quality code, with clear, concise, and maintainable code.
- Prefer simple, explicit abstractions over framework-heavy designs.
- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- Inline single-line helpers that have only one call site.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.

## Commands
- After code changes (not docs): `bun run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `bun run build` or `bun run test` unless requested by the user.
