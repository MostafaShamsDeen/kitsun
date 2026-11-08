# Kitsun

**All your AI tools in one window.** Kitsun is a Windows desktop app that keeps every AI assistant you use (Claude, ChatGPT, Gemini, Perplexity, coding agents, local models) open side by side as tabs, each signed in to its own account, all running while you switch.

## The problem

People who work with AI all day juggle a dozen windows: several Claude accounts (work, personal, a client's), chat sites in browser tabs, coding assistants in terminals, local-model apps. Sign-ins collide, usage limits hit without warning, and it's easy to miss that an assistant finished or is waiting for an answer.

## What it does

- **Docks the real desktop apps.** Each Claude account runs as its own copy of the official Claude app, docked inside Kitsun with separate sign-in, settings and history, so every account's usage stays separate.
- **Any AI website as a tab**, each with its own isolated sign-in, so two ChatGPT tabs can be two accounts.
- **Desktop apps and terminals as tabs:** VS Code, Cursor, LM Studio, and command-line agents like Codex or Gemini CLI, docked in their own panes.
- **Knows what each assistant is doing.** It shows which tab is working, finished, or waiting for permission, tracks usage windows per account, and lets you search past sessions across accounts.
- **Add an AI in one click** from a built-in catalogue that detects what is already installed.
- Split view for two or three tabs, a tray mode that keeps everything running, and a fox mascot with one tail per open tab.

## Who it helps

Developers, researchers, creators and teams who use several AI tools and accounts every day and want them organised, separated and visible at a glance.

## Status

Working Windows app, used daily by its developer. Packaged with electron-packager (`npm run package`).

## Built with

Electron, Node.js, Win32 window docking through koffi, xterm.js with node-pty for terminals, and the Node test runner.

```bash
npm install
npm start
```

Developer notes: [docs/DEVELOPER-NOTES.md](docs/DEVELOPER-NOTES.md).
