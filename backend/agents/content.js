// Content agent: builds the prompt section from saved goals, memory items,
// and existing drafts so new content stays consistent with what exists.
const { db } = require('../db');

function buildSection() {
  const goals = db.prepare('SELECT text, category FROM goals ORDER BY id').all();
  const drafts = db.prepare('SELECT id, type, title, status FROM drafts ORDER BY created_at DESC LIMIT 10').all();
  const lines = ['CONTENT:'];
  if (goals.length) {
    lines.push('Goals:');
    for (const g of goals) lines.push(`- [${g.category || 'general'}] ${g.text}`);
  } else {
    lines.push('No goals saved.');
  }
  if (drafts.length) {
    lines.push('Recent drafts:');
    for (const d of drafts) lines.push(`- #${d.id} [${d.type || 'general'}] ${d.title || 'untitled'} (${d.status})`);
  } else {
    lines.push('No drafts yet.');
  }
  return lines.join('\n');
}

module.exports = { buildSection };
