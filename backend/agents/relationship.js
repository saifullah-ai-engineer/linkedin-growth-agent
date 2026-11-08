// Relationship agent: builds the prompt section from prospect stages,
// recorded interactions, notes, and follow up dates. No history is invented.
const { db } = require('../db');

function buildSection() {
  const prospects = db.prepare(
    'SELECT id, name, stage, last_interaction, next_action, follow_up_date FROM prospects ORDER BY follow_up_date ASC'
  ).all();
  const lines = ['RELATIONSHIPS:'];
  if (prospects.length === 0) {
    lines.push('No prospects saved yet. No relationship history exists.');
    return lines.join('\n');
  }
  const byStage = {};
  for (const p of prospects) byStage[p.stage] = (byStage[p.stage] || 0) + 1;
  lines.push(`Prospects by stage: ${Object.entries(byStage).map(([k, v]) => `${k} (${v})`).join(', ')}.`);
  const today = new Date().toISOString().slice(0, 10);
  const due = prospects.filter((p) => p.follow_up_date && p.follow_up_date <= today);
  lines.push(due.length ? `Follow ups due: ${due.length}.` : 'No follow ups due today.');
  for (const p of prospects.slice(0, 20)) {
    const interactions = db.prepare('SELECT kind, text, created_at FROM interactions WHERE prospect_id = ? ORDER BY created_at DESC LIMIT 3').all(p.id);
    lines.push(`- #${p.id} ${p.name}, stage ${p.stage}, last interaction ${p.last_interaction || 'none recorded'}, next action ${p.next_action || 'none'}, follow up ${p.follow_up_date || 'none'}.`);
    for (const it of interactions) lines.push(`  - ${it.kind || 'interaction'} on ${it.created_at}: ${it.text || ''}`);
  }
  return lines.join('\n');
}

module.exports = { buildSection };
