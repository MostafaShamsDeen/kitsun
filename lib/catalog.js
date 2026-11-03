// The AIs Kitsun knows how to add, and which of them this PC already has.
//
// Each entry is one thing a tab can be:
//   kind 'claude'   — the Claude desktop app, one copy per account (main.js docks it)
//   kind 'web'      — a website in its own sign-in (its own browser partition), shown in a pane
//   kind 'app'      — an installed desktop app, docked like Claude (not built yet: `soon`)
//   kind 'terminal' — a command-line AI in a built-in terminal (not built yet: `soon`)
// The page only ever names an entry by id; main looks up its url, command and download page here, so the page can never
// make Kitsun open an arbitrary address or run an arbitrary program.
//
// Detection is read-only and runs one PowerShell (installed programs from the Uninstall keys, Store packages, commands on
// PATH, a few known install folders); it is cached for a minute.

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const LOCAL = process.env.LOCALAPPDATA || '';
const PROGRAMS = path.join(LOCAL, 'Programs');

// group: where the picker lists it. detect: how to tell it is on this PC — display: a regex on an Uninstall entry's
// DisplayName; exe: likely exe paths; appx: a Store package name pattern; cmd: a command on PATH.
const CATALOG = [
  // Claude
  { id: 'claude', kind: 'claude', group: 'Claude', name: 'Claude', by: 'Anthropic', color: '#d97757', blurb: 'The Claude desktop app: chat, Code, Cowork. One tab per account.', get: 'https://claude.ai/download' },

  // Chat on the web
  { id: 'chatgpt-web', kind: 'web', group: 'Chat', name: 'ChatGPT', by: 'OpenAI', color: '#10a37f', url: 'https://chatgpt.com/', blurb: 'GPT models, images, voice and projects.' },
  { id: 'gemini-web', kind: 'web', group: 'Chat', name: 'Gemini', by: 'Google', color: '#4f8df7', url: 'https://gemini.google.com/app', blurb: 'Google\'s assistant, linked to your Google apps.' },
  { id: 'copilot-web', kind: 'web', group: 'Chat', name: 'Copilot', by: 'Microsoft', color: '#3fb6e8', url: 'https://copilot.microsoft.com/', blurb: 'Microsoft\'s assistant with Bing search.' },
  { id: 'grok-web', kind: 'web', group: 'Chat', name: 'Grok', by: 'xAI', color: '#9b968c', url: 'https://grok.com/', blurb: 'xAI\'s assistant with live X posts.' },
  { id: 'deepseek-web', kind: 'web', group: 'Chat', name: 'DeepSeek', by: 'DeepSeek', color: '#4d6bfe', url: 'https://chat.deepseek.com/', blurb: 'Strong open-weight reasoning models.' },
  { id: 'mistral-web', kind: 'web', group: 'Chat', name: 'Le Chat', by: 'Mistral', color: '#fa520f', url: 'https://chat.mistral.ai/', blurb: 'Mistral\'s fast assistant.' },
  { id: 'meta-web', kind: 'web', group: 'Chat', name: 'Meta AI', by: 'Meta', color: '#0081fb', url: 'https://www.meta.ai/', blurb: 'Llama-based assistant.' },
  { id: 'qwen-web', kind: 'web', group: 'Chat', name: 'Qwen Chat', by: 'Alibaba', color: '#615ced', url: 'https://chat.qwen.ai/', blurb: 'Qwen models, open and hosted.' },
  { id: 'kimi-web', kind: 'web', group: 'Chat', name: 'Kimi', by: 'Moonshot AI', color: '#e5b84f', url: 'https://www.kimi.com/', blurb: 'Long-context assistant.' },
  { id: 'poe-web', kind: 'web', group: 'Chat', name: 'Poe', by: 'Quora', color: '#5d5cde', url: 'https://poe.com/', blurb: 'Many models behind one sign-in.' },
  { id: 'huggingchat-web', kind: 'web', group: 'Chat', name: 'HuggingChat', by: 'Hugging Face', color: '#ffb000', url: 'https://huggingface.co/chat/', blurb: 'Open models, free to try.' },
  { id: 'claude-web', kind: 'web', group: 'Chat', name: 'Claude (web)', by: 'Anthropic', color: '#c96442', url: 'https://claude.ai/', blurb: 'claude.ai in a tab. The desktop app above does more.' },

  // Research
  { id: 'perplexity-web', kind: 'web', group: 'Research', name: 'Perplexity', by: 'Perplexity', color: '#20b8cd', url: 'https://www.perplexity.ai/', blurb: 'Answers with sources from the web.' },
  { id: 'notebooklm-web', kind: 'web', group: 'Research', name: 'NotebookLM', by: 'Google', color: '#9b72cb', url: 'https://notebooklm.google.com/', blurb: 'Chat with your documents; audio overviews.' },
  { id: 'aistudio-web', kind: 'web', group: 'Research', name: 'Google AI Studio', by: 'Google', color: '#4285f4', url: 'https://aistudio.google.com/', blurb: 'Try every Gemini model and get API keys.' },

  // Build apps and sites
  { id: 'v0-web', kind: 'web', group: 'Build', name: 'v0', by: 'Vercel', color: '#ece9e2', url: 'https://v0.app/', blurb: 'Describe an app or page and get the code.' },
  { id: 'lovable-web', kind: 'web', group: 'Build', name: 'Lovable', by: 'Lovable', color: '#ff5a7a', url: 'https://lovable.dev/', blurb: 'Build full apps by chatting.' },
  { id: 'bolt-web', kind: 'web', group: 'Build', name: 'Bolt', by: 'StackBlitz', color: '#1389fd', url: 'https://bolt.new/', blurb: 'Prompt, run and deploy web apps.' },
  { id: 'replit-web', kind: 'web', group: 'Build', name: 'Replit', by: 'Replit', color: '#f26207', url: 'https://replit.com/', blurb: 'Online IDE with an AI agent.' },

  // Create images, video and sound
  { id: 'higgsfield-web', kind: 'web', group: 'Create', name: 'Higgsfield', by: 'Higgsfield', color: '#c6f432', url: 'https://higgsfield.ai/', blurb: 'AI video and image studio.' },
  { id: 'midjourney-web', kind: 'web', group: 'Create', name: 'Midjourney', by: 'Midjourney', color: '#e06c9f', url: 'https://www.midjourney.com/', blurb: 'Image generation.' },
  { id: 'ideogram-web', kind: 'web', group: 'Create', name: 'Ideogram', by: 'Ideogram', color: '#c678dd', url: 'https://ideogram.ai/', blurb: 'Images with readable text.' },
  { id: 'runway-web', kind: 'web', group: 'Create', name: 'Runway', by: 'Runway', color: '#4fb8c9', url: 'https://app.runwayml.com/', blurb: 'AI video generation and editing.' },
  { id: 'elevenlabs-web', kind: 'web', group: 'Create', name: 'ElevenLabs', by: 'ElevenLabs', color: '#9b968c', url: 'https://elevenlabs.io/app', blurb: 'Voices, dubbing and sound effects.' },
  { id: 'suno-web', kind: 'web', group: 'Create', name: 'Suno', by: 'Suno', color: '#e5b84f', url: 'https://suno.com/', blurb: 'Songs from a prompt.' },

  // Desktop apps
  { id: 'chatgpt-app', kind: 'app', group: 'Desktop apps', name: 'ChatGPT app', by: 'OpenAI', color: '#10a37f', blurb: 'The ChatGPT Windows app.', get: 'https://openai.com/chatgpt/download/', detect: { appx: /OpenAI\.ChatGPT/i, display: /^ChatGPT$/i } },
  { id: 'perplexity-app', kind: 'app', group: 'Desktop apps', name: 'Perplexity app', by: 'Perplexity', color: '#20b8cd', blurb: 'Perplexity for Windows.', get: 'https://www.perplexity.ai/download', detect: { display: /^Perplexity/i, exe: [path.join(PROGRAMS, 'Perplexity', 'Perplexity.exe')] } },
  { id: 'vscode-app', kind: 'app', group: 'Desktop apps', name: 'VS Code', by: 'Microsoft', color: '#3fb6e8', blurb: 'Editor with Copilot and AI extensions.', get: 'https://code.visualstudio.com/', detect: { display: /^Microsoft Visual Studio Code/i, exe: [path.join(PROGRAMS, 'Microsoft VS Code', 'Code.exe')] } },
  { id: 'cursor-app', kind: 'app', group: 'Desktop apps', name: 'Cursor', by: 'Anysphere', color: '#ece9e2', blurb: 'AI-first code editor.', get: 'https://cursor.com/download', detect: { display: /^Cursor/i, exe: [path.join(PROGRAMS, 'cursor', 'Cursor.exe')] } },
  { id: 'windsurf-app', kind: 'app', group: 'Desktop apps', name: 'Windsurf', by: 'Windsurf', color: '#3fb68b', blurb: 'AI code editor with agents.', get: 'https://windsurf.com/download', detect: { display: /^Windsurf/i, exe: [path.join(PROGRAMS, 'Windsurf', 'Windsurf.exe')] } },
  { id: 'zed-app', kind: 'app', group: 'Desktop apps', name: 'Zed', by: 'Zed Industries', color: '#5b8def', blurb: 'Fast editor with built-in AI.', get: 'https://zed.dev/download', detect: { display: /^Zed\b/i, exe: [path.join(PROGRAMS, 'Zed', 'Zed.exe')] } },

  // Local models (run on this PC)
  { id: 'lmstudio-app', kind: 'app', group: 'Local models', name: 'LM Studio', by: 'LM Studio', color: '#6c5ce7', blurb: 'Download and chat with models on your own PC.', get: 'https://lmstudio.ai/', detect: { display: /^LM Studio/i, exe: [path.join(PROGRAMS, 'LM Studio', 'LM Studio.exe')] } },
  { id: 'ollama-app', kind: 'app', group: 'Local models', name: 'Ollama', by: 'Ollama', color: '#ece9e2', blurb: 'Run open models locally; has its own chat app.', get: 'https://ollama.com/download', detect: { display: /^Ollama/i, exe: [path.join(PROGRAMS, 'Ollama', 'ollama app.exe')], cmd: 'ollama' } },
  { id: 'jan-app', kind: 'app', group: 'Local models', name: 'Jan', by: 'Menlo Research', color: '#4fb8c9', blurb: 'Open-source local chat app.', get: 'https://jan.ai/', detect: { display: /^Jan\b/i, exe: [path.join(PROGRAMS, 'jan', 'Jan.exe'), path.join(PROGRAMS, 'Jan', 'Jan.exe')] } },
  { id: 'gpt4all-app', kind: 'app', group: 'Local models', name: 'GPT4All', by: 'Nomic', color: '#3fb68b', blurb: 'Private local chat with your documents.', get: 'https://www.nomic.ai/gpt4all', detect: { display: /^GPT4All/i } },
  { id: 'msty-app', kind: 'app', group: 'Local models', name: 'Msty', by: 'Msty', color: '#e06c9f', blurb: 'Local and online models side by side.', get: 'https://msty.ai/', detect: { display: /^Msty/i, exe: [path.join(PROGRAMS, 'Msty', 'Msty.exe')] } },
  { id: 'anythingllm-app', kind: 'app', group: 'Local models', name: 'AnythingLLM', by: 'Mintplex Labs', color: '#5b8def', blurb: 'Local models plus your documents and agents.', get: 'https://anythingllm.com/desktop', detect: { display: /^AnythingLLM/i } },

  // Coding in a terminal
  { id: 'claude-code', kind: 'terminal', group: 'Terminal', name: 'Claude Code', by: 'Anthropic', color: '#d97757', blurb: 'Anthropic\'s coding agent in a terminal.', get: 'https://docs.claude.com/en/docs/claude-code/setup', command: 'claude', detect: { cmd: 'claude' } },
  { id: 'codex-cli', kind: 'terminal', group: 'Terminal', name: 'Codex CLI', by: 'OpenAI', color: '#10a37f', blurb: 'OpenAI\'s coding agent in a terminal.', get: 'https://github.com/openai/codex', command: 'codex', detect: { cmd: 'codex' } },
  { id: 'gemini-cli', kind: 'terminal', group: 'Terminal', name: 'Gemini CLI', by: 'Google', color: '#4f8df7', blurb: 'Google\'s coding agent in a terminal.', get: 'https://github.com/google-gemini/gemini-cli', command: 'gemini', detect: { cmd: 'gemini' } },
  { id: 'copilot-cli', kind: 'terminal', group: 'Terminal', name: 'Copilot CLI', by: 'GitHub', color: '#9b968c', blurb: 'GitHub Copilot in a terminal.', get: 'https://github.com/github/copilot-cli', command: 'copilot', detect: { cmd: 'copilot' } },
  { id: 'opencode-cli', kind: 'terminal', group: 'Terminal', name: 'OpenCode', by: 'SST', color: '#e5b84f', blurb: 'Open-source coding agent; any model.', get: 'https://opencode.ai/', command: 'opencode', detect: { cmd: 'opencode' } },
  { id: 'aider-cli', kind: 'terminal', group: 'Terminal', name: 'Aider', by: 'Aider', color: '#3fb68b', blurb: 'Pair programming with any model, in Git.', get: 'https://aider.chat/', command: 'aider', detect: { cmd: 'aider' } },
  { id: 'qwen-cli', kind: 'terminal', group: 'Terminal', name: 'Qwen Code', by: 'Alibaba', color: '#615ced', blurb: 'Qwen\'s coding agent in a terminal.', get: 'https://github.com/QwenLM/qwen-code', command: 'qwen', detect: { cmd: 'qwen' } },
  { id: 'ollama-cli', kind: 'terminal', group: 'Terminal', name: 'Ollama (terminal)', by: 'Ollama', color: '#ece9e2', blurb: 'Chat with a local model with ollama run.', get: 'https://ollama.com/download', command: 'ollama', detect: { cmd: 'ollama' } },
];

// Your own: any website, app or command.
const CUSTOM = [
  { id: 'custom-web', kind: 'web', group: 'Your own', name: 'Any website', by: '', color: '#9b968c', blurb: 'Type the address of any AI site.', custom: true },
  { id: 'custom-app', kind: 'app', group: 'Your own', name: 'Any app', by: '', color: '#9b968c', blurb: 'Pick a program installed on this PC.', custom: true },
  { id: 'custom-terminal', kind: 'terminal', group: 'Your own', name: 'Any command', by: '', color: '#9b968c', blurb: 'Run any command-line tool in a terminal.', custom: true },
];

const ALL = [...CATALOG, ...CUSTOM];
const GROUPS = ['Claude', 'Chat', 'Research', 'Build', 'Create', 'Desktop apps', 'Local models', 'Terminal', 'Your own'];
const byId = (id) => ALL.find((e) => e.id === id) || null;

// A website a tab may show: https only (http for this PC's own servers, e.g. a local model's web UI).
function safeUrl(text) {
  let u;
  try { u = new URL(String(text).trim()); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password) return null;
  return u.toString();
}

const DETECT_PS = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference='SilentlyContinue'
$keys='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$progs=@(Get-ItemProperty $keys | Where-Object { $_.DisplayName } | ForEach-Object { @{ name=[string]$_.DisplayName; icon=[string]$_.DisplayIcon; loc=[string]$_.InstallLocation } })
$appx=@(Get-AppxPackage | ForEach-Object { [string]$_.Name })
$cmds=@{}; foreach($c in $args){ $g=Get-Command $c -CommandType Application,ExternalScript | Select-Object -First 1; if($g){ $cmds[$c]=[string]$g.Source } }
@{ programs=$progs; appx=$appx; cmds=$cmds } | ConvertTo-Json -Depth 4 -Compress`;

function runDetect(cmds) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${DETECT_PS} } ${cmds.join(' ')}`], { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(String(stdout).trim() || '{}')); } catch { resolve(null); }
    });
  });
}

// An Uninstall entry's exe: DisplayIcon ("C:\…\App.exe,0") if it is an exe, else nothing.
function exeOf(p) {
  const icon = String(p.icon || '').replace(/^"|"?,-?\d+$|"$/g, '');
  return /\.exe$/i.test(icon) && fs.existsSync(icon) ? icon : null;
}

function createCatalog({ claudeInstalled = () => false } = {}) {
  let cache = null;
  let at = 0;
  let inflight = null;

  // id -> { installed, exe?, cmd? } for every entry that can be detected; Claude from main's own check.
  async function detect({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - at < 60000) return cache;
    inflight ??= (async () => {
      const cmds = [...new Set(CATALOG.map((e) => e.detect && e.detect.cmd).filter(Boolean))];
      const r = (await runDetect(cmds)) || { programs: [], appx: [], cmds: {} };
      const programs = [].concat(r.programs || []);
      const appx = [].concat(r.appx || []);
      const found = {};
      for (const e of CATALOG) {
        if (e.kind === 'claude') { found[e.id] = { installed: Boolean(claudeInstalled()) }; continue; }
        const d = e.detect;
        if (!d) continue;
        let exe = (d.exe || []).find((p) => fs.existsSync(p)) || null;
        const prog = d.display ? programs.find((p) => d.display.test(p.name)) : null;
        if (!exe && prog) exe = exeOf(prog);
        const store = d.appx ? appx.some((n) => d.appx.test(n)) : false;
        const cmd = d.cmd && r.cmds ? r.cmds[d.cmd] || null : null;
        found[e.id] = { installed: Boolean(exe || prog || store || cmd), exe, cmd };
      }
      cache = found;
      at = Date.now();
      return found;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  // What the page gets: no paths. soon: the kind can't be added yet.
  async function list({ fresh = false, kinds = ['claude', 'web'] } = {}) {
    const found = await detect({ fresh });
    return {
      groups: GROUPS,
      entries: ALL.map((e) => ({
        id: e.id, kind: e.kind, group: e.group, name: e.name, by: e.by, color: e.color, blurb: e.blurb,
        url: e.url || null, custom: Boolean(e.custom), canGet: Boolean(e.get),
        installed: e.kind === 'web' ? null : found[e.id] ? found[e.id].installed : null,
        soon: !kinds.includes(e.kind),
      })),
    };
  }

  return { list, detect, find: byId };
}

module.exports = { createCatalog, CATALOG: ALL, GROUPS, findEntry: byId, safeUrl };
