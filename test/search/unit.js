// Unit checks for lib/search.js's pure helpers.
const assert = require('assert');
const { sessionLink, firstPrompt, tokensOf, modelWords, SESSION_ID_RE } = require('D:/Claud/multi-claude/lib/search.js');
const J = (o) => JSON.stringify(o);

// sessionLink: only Claude's own session id form; nothing that could add query parameters or paths.
assert.strictEqual(sessionLink('local_0b6e4f7a-1c2d-4e5f-8a9b-0c1d2e3f4a5b'), 'claude://code/continue?session=local_0b6e4f7a-1c2d-4e5f-8a9b-0c1d2e3f4a5b');
for (const bad of ['', 'local_', 'cse_abc', 'local_a&b=c', 'local_a/../b', 'local_a b', `local_${'a'.repeat(65)}`, 'last', null, 42, {}]) assert.strictEqual(sessionLink(bad), null, J(bad));
assert(SESSION_ID_RE.test(`local_${'a'.repeat(64)}`));
console.log('ok sessionLink');

// firstPrompt: skips meta lines, reminders, tool results, scheduled-task instructions; reads text blocks; tolerates a cut last line.
const t = [
  J({ type: 'summary', summary: 'x' }),
  J({ type: 'user', isMeta: true, message: { content: 'Caveat: meta' } }),
  J({ type: 'user', message: { content: '<scheduled-task name="x">do it</scheduled-task>' } }),
  J({ type: 'user', message: { content: [{ type: 'tool_result', content: 'out' }] } }),
  J({ type: 'user', isSidechain: true, message: { content: 'subagent prompt' } }),
  J({ type: 'user', message: { content: [{ type: 'image' }, { type: 'text', text: '  Fix the   login\nbug ' }] } }),
  J({ type: 'user', message: { content: 'second' } }),
  '{"type":"user","message":{"content":"cut off',
].join('\n');
assert.strictEqual(firstPrompt(t), 'Fix the login bug');
assert.strictEqual(firstPrompt(J({ type: 'user', message: { content: '<scheduled-task>x</scheduled-task>' } })), null);
assert.strictEqual(firstPrompt(''), null);
assert.strictEqual(firstPrompt(J({ type: 'user', message: { content: 'x'.repeat(5000) } })).length, 2000);
console.log('ok firstPrompt');

assert.deepStrictEqual(tokensOf('  Spend  TRACKER spend '), ['spend', 'tracker']);
assert.deepStrictEqual(tokensOf('a b c d e f g h i j'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
assert.deepStrictEqual(tokensOf(null), []);
assert.strictEqual(modelWords('claude-opus-5-5'), 'opus 5.5');
assert.strictEqual(modelWords('claude-sonnet-4-5-20250929'), 'sonnet 4.5');
console.log('ok tokens and model names');
