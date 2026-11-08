// Profile agent: builds the prompt section from saved identity facts only.
// It never invents profile details. If no memory items exist, it says so.
const { db } = require('../db');

function buildSection() {
  const items = db.prepare('SELECT key, value, category FROM memory_items ORDER BY id').all();
  if (items.length === 0) {
    return 'PROFILE: No saved profile facts. Ask the user to add identity, services, and positioning in Memory before drafting profile copy.';
  }
  const lines = items.map((i) => `- ${i.key}: ${i.value}`);
  return `PROFILE (saved facts only, do not add anything not listed here):\n${lines.join('\n')}`;
}

function getProfileFacts() {
  const items = db.prepare('SELECT key, value, category FROM memory_items ORDER BY id').all();
  const facts = {};
  for (const item of items) facts[item.key] = item.value;
  return facts;
}

module.exports = { buildSection, getProfileFacts };
