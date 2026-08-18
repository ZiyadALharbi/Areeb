# Areeb

Areeb is an experimental framework for building coding agents.

The project follows a layered architecture with clear separation of concerns. Each layer has a focused responsibility and depends only on the layers below it.

## Architecture

```text
Coding Layer
     ↓
Agent Layer
     ↓
AI Layer
```

### AI Layer

Defines how models communicate with the system, including streaming responses, messages, reasoning, and tool calls.

An OpenAI-compatible provider is currently included for experimentation. Support for additional providers will be added later.

### Agent Layer

Provides the core agent runtime, including the agent loop, tool execution, events, conversation state, and session management.

This layer depends on the AI layer but contains no coding-specific behavior.

### Coding Layer

Builds coding-agent features on top of the agent runtime, including file operations, shell commands, skills, prompt templates, and project context.
