// Audience agent: builds the prompt section from real prospects and goals.
// It reports only what the database actually holds.
const { db } = require('../db');

function buildSection() {
  const prospects = db.prepare(
    'SELECT id, name, company, title, industry, expertise, stage, relevance_score FROM prospects ORDER BY id'
  ).all();
  const goals = db.prepare("SELECT text FROM goals WHERE category = 'growth' ORDER BY id").all();
  const lines = [];
  lines.push('AUDIENCE:');
  if (goals.length) {
    lines.push('Growth goals:');
    for (const g of goals) lines.push(`- ${g.text}`);
  } else {
    lines.push('No growth goals saved.');
  }
  if (prospects.length === 0) {
    lines.push('No prospects saved yet. Do not invent an audience. Ask the user who to target.');
    return lines.join('\n');
  }
  const byIndustry = {};
  for (const p of prospects) {
    const key = p.industry || 'Unknown industry';
    byIndustry[key] = (byIndustry[key] || 0) + 1;
  }
  lines.push(`Prospects on file: ${prospects.length}. By industry: ${Object.entries(byIndustry).map(([k, v]) => `${k} (${v})`).join(', ')}.`);
  for (const p of prospects.slice(0, 20)) {
    lines.push(`- #${p.id} ${p.name}, ${p.title || 'no title'} at ${p.company || 'no company'}, ${p.industry || 'no industry'}, stage ${p.stage}, relevance ${p.relevance_score == null ? 'not scored' : p.relevance_score}`);
  }
  return lines.join('\n');
}

module.exports = { buildSection };
