// Prints the attention-related fields of each real session, newest first.
const all = require('./all.json');
const now = Date.now();
const ago = (t) => (t ? `${Math.round((now - t) / 60000)}m` : '-');
all.sort((a, b) => (b.s.lastActivityAt || 0) - (a.s.lastActivityAt || 0));
for (const { acct, s, mtime } of all.slice(0, Number(process.argv[2]) || 40)) {
  console.log([
    acct.padEnd(8), (s.title || '').slice(0, 34).padEnd(34),
    'arch', s.isArchived ? 1 : 0,
    'act', ago(s.lastActivityAt), 'mt', ago(mtime),
    'foc', ago(s.lastFocusedAt), 'edge', ago(s.lastTurnEdgeAt), 'user', ago(s.latestUserFrameAt),
    'turns', s.completedTurns,
    'iAP', JSON.stringify(s.interruptedAwaitingPerson),
    'cut', JSON.stringify(s.lastTurnCutShort),
    'pts', s.postTurnSummary ? JSON.stringify({ c: s.postTurnSummary.status_category, n: s.postTurnSummary.needs_action }) : '-',
    'ptsFor', JSON.stringify(s.postTurnSummaryFor),
    'wrap', s.turnWrapUp ? JSON.stringify(s.turnWrapUp).slice(0, 160) : '-',
    'sched', s.scheduledTaskId ? 'Y' : '-',
  ].join(' '));
}
