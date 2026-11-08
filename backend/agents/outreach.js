// Outreach agent: builds the prompt section from Target stage prospects,
// their notes, and recorded interactions. It never invents prior contact.
const { db } = require('../db');

function buildSection() {
  const prospects = db.prepare(
    "SELECT id, name, company, title, industry, opportunity, relevance_score, relevance_reason FROM prospects WHERE stage = 'Target' ORDER BY relevance_score DESC"
  ).all();
  const lines = ['OUTREACH:'];
  if (prospects.length === 0) {
    lines.push('No Target stage prospects. Do not invent outreach targets. Ask the user to add prospects first.');
    return lines.join('\n');
  }
  lines.push(`Target prospects: ${prospects.length}.`);
  for (const p of prospects.slice(0, 20)) {
    const noteCount = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE prospect_id = ?').get(p.id).c;
    const interactionCount = db.prepare('SELECT COUNT(*) AS c FROM interactions WHERE prospect_id = ?').get(p.id).c;
    lines.push(`- #${p.id} ${p.name}, ${p.title || 'no title'} at ${p.company || 'no company'}, ${p.industry || 'no industry'}, opportunity: ${p.opportunity || 'not recorded'}, relevance ${p.relevance_score == null ? 'not scored' : p.relevance_score} (${p.relevance_reason || 'no reason recorded'}), ${noteCount} notes, ${interactionCount} recorded interactions.`);
  }
  return lines.join('\n');
}

module.exports = { buildSection };
