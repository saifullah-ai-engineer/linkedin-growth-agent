// Strategist: orchestrator. Classifies the request, gathers real evidence
// from goals, memory, prospects, and interactions, calls the AI proxy, and
// stores the recommendation with its evidence. It never invents evidence.
const { db, logError } = require('../db');
const profile = require('./profile');
const audience = require('./audience');
const relationship = require('./relationship');
const content = require('./content');
const outreach = require('./outreach');
const openrouter = require('../openrouter');

function classifyRequest(message) {
  const text = String(message || '').toLowerCase();
  if (/(audience|target|founder|cto|recruiter|who should|ideal customer)/.test(text)) return 'audience';
  if (/(follow up|follow-up|relationship|reconnect|check in|nurture)/.test(text)) return 'relationship';
  if (/(post|content|article|write|draft|hook|caption)/.test(text)) return 'content';
  if (/(outreach|message|dm|cold|pitch|connect)/.test(text)) return 'outreach';
  if (/(profile|headline|about|bio|position)/.test(text)) return 'profile';
  return 'general';
}

function gatherEvidence() {
  const goals = db.prepare('SELECT id, text, category FROM goals ORDER BY id').all();
  const memory = db.prepare('SELECT id, key, value, category FROM memory_items ORDER BY id').all();
  const prospects = db.prepare('SELECT id, name, company, title, industry, stage, relevance_score, opportunity, follow_up_date FROM prospects ORDER BY id').all();
  const interactions = db.prepare('SELECT id, prospect_id, kind, text, created_at FROM interactions ORDER BY created_at DESC LIMIT 20').all();
  return { goals, memory, prospects, interactions };
}

function buildSystemPrompt(classification) {
  const sections = [
    profile.buildSection(),
    audience.buildSection(),
    relationship.buildSection(),
    content.buildSection(),
    outreach.buildSection(),
  ];
  return [
    'You are the LinkedIn strategist for Saif Ullah, Agentic AI Engineer at TechAurah.',
    'Use ONLY the evidence below and text the user pasted in this request. Never invent prospect data, conversation history, LinkedIn stats, or results.',
    'If the evidence is insufficient to answer, say so plainly and ask for the missing input.',
    `The request was classified as: ${classification}.`,
    'Reply with JSON only, in exactly this shape:',
    '{"recommendation": "...", "reasoning": "...", "evidence": [{"type": "goal|memory|prospect|interaction|user_input", "ref": "...", "detail": "..."}], "nextAction": "...", "draft": "..."}',
    'Evidence entries must point at real rows listed below or at the user pasted text.',
    '',
    sections.join('\n\n'),
  ].join('\n');
}

async function runStrategist(message, pastedText) {
  const classification = classifyRequest(message);
  const evidence = gatherEvidence();
  const system = buildSystemPrompt(classification);
  const userParts = [`User request: ${message || ''}`];
  if (pastedText) userParts.push(`User pasted text: ${pastedText}`);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n') },
  ];
  let result;
  try {
    result = await openrouter.chatWithFallback(messages, {});
  } catch (err) {
    if (err.code === 'not_configured') {
      const wrapped = new Error('not_configured');
      wrapped.code = 'not_configured';
      wrapped.setup = err.setup || openrouter.SETUP_STEPS;
      throw wrapped;
    }
    logError('strategist', err.message);
    const wrapped = new Error(err.message);
    wrapped.code = err.code || 'model_error';
    wrapped.detail = err.detail || err.message;
    throw wrapped;
  }
  let parsed = openrouter.validateStructured(openrouter.extractJson(result.content));
  if (!parsed) {
    try {
      const retry = await openrouter.chatWithFallback(messages, {});
      parsed = openrouter.validateStructured(openrouter.extractJson(retry.content));
    } catch (err) {
      logError('strategist', `retry failed: ${err.message}`);
    }
  }
  if (!parsed) {
    logError('strategist', 'Model returned invalid JSON twice.');
    const wrapped = new Error('Model returned invalid JSON.');
    wrapped.code = 'invalid_response';
    wrapped.detail = 'The model did not return valid structured JSON after two attempts.';
    throw wrapped;
  }
  const insert = db.prepare(
    'INSERT INTO recommendations (text, reasoning, evidence_json, next_action, status) VALUES (?, ?, ?, ?, ?)'
  ).run(parsed.recommendation, parsed.reasoning, JSON.stringify(parsed.evidence), parsed.nextAction, 'pending');
  return { id: insert.lastInsertRowid, classification, ...parsed, modelUsed: result.modelUsed };
}

module.exports = { classifyRequest, gatherEvidence, buildSystemPrompt, runStrategist };
