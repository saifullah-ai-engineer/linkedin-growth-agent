/* LinkedIn Intelligence and Growth Agent dashboard.
   Talks only to the same-origin backend API. Never contacts
   OpenRouter or LinkedIn directly. Token lives in sessionStorage. */
(function () {
  'use strict';

  var TOKEN_KEY = 'li_token';
  var STAGES = ['Target', 'Research', 'Connection Requested', 'Connected', 'Conversation', 'Qualified Opportunity', 'Meeting', 'Proposal', 'Won', 'Lost'];
  var CLOSED_STAGES = ['Won', 'Lost'];
  var WRITING_MODES = ['Professional', 'Friendly', 'Thoughtful', 'Technical', 'Founder-to-founder', 'AI expert', 'Business development', 'Collaboration-focused'];

  var state = {
    token: sessionStorage.getItem(TOKEN_KEY) || '',
    prospects: [],
    drafts: [],
    goals: [],
    memory: [],
    models: [],
    config: null,
    killswitch: false,
    aiConfigured: null,
    currentPage: 'overview'
  };

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function asArray(v) { return Array.isArray(v) ? v : []; }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function isDue(p) {
    var d = p.follow_up_date || p.followUpDate || p.next_follow_up || '';
    if (!d) return false;
    if (CLOSED_STAGES.indexOf(p.stage) !== -1) return false;
    return String(d).slice(0, 10) <= todayStr();
  }
  function toast(msg, isError) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.hidden = true; }, 6000);
  }
  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      btn.dataset.label = btn.textContent;
      btn.textContent = label || 'Loading...';
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.label || btn.textContent;
      btn.disabled = false;
    }
  }
  function show(el, visible) { el.hidden = !visible; }

  function apiErrorText(res, data) {
    if (data && (data.error || data.detail || data.message)) {
      return (data.error || data.detail || data.message) + (data.code ? ' (' + data.code + ')' : '');
    }
    return 'Request failed with status ' + res.status;
  }

  async function api(path, options) {
    options = options || {};
    var headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    var res;
    try {
      res = await fetch(path, {
        method: options.method || 'GET',
        headers: headers,
        body: options.body ? JSON.stringify(options.body) : undefined
      });
    } catch (e) {
      throw new Error('Could not reach the backend. Check that it is running on this machine.');
    }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 401) {
      state.token = '';
      sessionStorage.removeItem(TOKEN_KEY);
      showLogin('Your session ended. Please sign in again.');
      throw new Error('Signed out. Please sign in again.');
    }
    if (!res.ok) throw new Error(apiErrorText(res, data));
    return data;
  }

  function authHeaders() {
    return state.token ? { Authorization: 'Bearer ' + state.token } : {};
  }

  /* ---------- screens ---------- */

  function showScreen(name) {
    show($('screen-backend-down'), name === 'down');
    show($('screen-setup'), name === 'setup');
    show($('screen-login'), name === 'login');
    show($('app'), name === 'app');
  }
  function showLogin(msg) {
    if (msg) {
      var e = $('login-error');
      e.textContent = msg;
      e.hidden = false;
    }
    showScreen('login');
  }

  async function boot() {
    var status;
    try {
      var res = await fetch('/api/auth/status');
      status = await res.json();
    } catch (e) {
      showScreen('down');
      return;
    }
    if (status.setupNeeded) {
      showScreen('setup');
      return;
    }
    if (state.token) {
      try {
        await api('/api/config');
        enterApp();
        return;
      } catch (e) {
        if (String(e.message).indexOf('Signed out') !== -1) return;
        showLogin();
        return;
      }
    }
    showLogin();
  }

  $('btn-retry-backend').addEventListener('click', boot);

  $('form-setup').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var p1 = $('setup-password').value;
    var p2 = $('setup-password2').value;
    var err = $('setup-error');
    if (p1 !== p2) { err.textContent = 'Passwords do not match.'; err.hidden = false; return; }
    var btn = ev.target.querySelector('button[type="submit"]');
    setBusy(btn, true, 'Creating...');
    try {
      var data = await api('/api/auth/setup', { method: 'POST', body: { password: p1 } });
      if (data.token) {
        state.token = data.token;
        sessionStorage.setItem(TOKEN_KEY, data.token);
      }
      err.hidden = true;
      enterApp();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      setBusy(btn, false);
    }
  });

  $('form-login').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = ev.target.querySelector('button[type="submit"]');
    var err = $('login-error');
    setBusy(btn, true, 'Signing in...');
    try {
      var data = await api('/api/auth/login', { method: 'POST', body: { password: $('login-password').value } });
      if (!data.token) throw new Error('Login did not return a token.');
      state.token = data.token;
      sessionStorage.setItem(TOKEN_KEY, data.token);
      $('login-password').value = '';
      err.hidden = true;
      enterApp();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      setBusy(btn, false);
    }
  });

  function logout() {
    state.token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    showLogin();
  }
  $('btn-logout').addEventListener('click', logout);
  $('btn-logout-2').addEventListener('click', logout);

  function enterApp() {
    showScreen('app');
    $('ext-token').value = state.token;
    refreshStatusPills();
    loadPage('overview');
  }

  async function refreshStatusPills() {
    try {
      var cfg = await api('/api/config');
      state.config = cfg;
      state.aiConfigured = !!cfg.keyConfigured;
      var pill = $('ai-status');
      pill.textContent = cfg.keyConfigured ? 'AI: configured' : 'AI: not configured';
      pill.className = 'pill ' + (cfg.keyConfigured ? 'on' : 'warn');
    } catch (e) {
      $('ai-status').textContent = 'AI: unknown';
      $('ai-status').className = 'pill';
    }
    try {
      var ks = await api('/api/killswitch');
      state.killswitch = !!(ks.enabled === true || ks.killswitch === true);
      var kp = $('kill-status');
      kp.textContent = state.killswitch ? 'Kill switch: ON' : 'Kill switch: off';
      kp.className = 'pill ' + (state.killswitch ? 'warn' : '');
      $('kill-toggle').checked = state.killswitch;
      $('kill-note').textContent = state.killswitch
        ? 'Kill switch is ON. AI actions and extension actions are stopped.'
        : 'Kill switch is off. AI actions are allowed.';
    } catch (e) {
      $('kill-note').textContent = 'Could not load kill switch state: ' + e.message;
    }
  }

  /* ---------- navigation ---------- */

  var TITLES = {
    overview: 'Overview', strategist: 'AI Strategist', audience: 'Audience Intelligence',
    prospects: 'Prospects', crm: 'Relationship CRM', conversations: 'Conversations',
    content: 'Content Studio', profile: 'Profile Optimizer', extension: 'Browser Extension',
    strategy: 'Strategy and Goals', analytics: 'Analytics', config: 'Model Configuration', settings: 'Settings'
  };

  function loadPage(page) {
    state.currentPage = page;
    $('page-title').textContent = TITLES[page] || page;
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.page === page);
    });
    document.querySelectorAll('.page').forEach(function (s) {
      s.hidden = s.id !== 'page-' + page;
    });
    $('toast').hidden = true;
    var loaders = {
      overview: loadOverview, strategist: function () {},
      audience: loadAudience, prospects: loadProspects, crm: loadCrm,
      conversations: loadConversationProspects, content: loadContentPage,
      profile: function () {}, extension: function () {},
      strategy: loadStrategy, analytics: loadAnalytics, config: loadConfig,
      settings: loadSettings
    };
    if (loaders[page]) loaders[page]();
    if (window.innerWidth <= 860) document.querySelector('.sidebar').classList.add('closed');
  }

  document.querySelectorAll('.nav-btn').forEach(function (b) {
    b.addEventListener('click', function () { loadPage(b.dataset.page); });
  });
  $('btn-menu').addEventListener('click', function () {
    document.querySelector('.sidebar').classList.toggle('closed');
  });

  /* ---------- shared renderers ---------- */

  function aiNotConfiguredHtml() {
    return '<div class="notice"><h3>AI not configured</h3>' +
      '<p>The backend has no OpenRouter API key yet, so no AI answer can be generated. Nothing was invented in place of a real answer.</p>' +
      '<ol><li>Open <strong>Model Configuration</strong> in the left menu.</li>' +
      '<li>Paste your OpenRouter API key and save it.</li>' +
      '<li>Pick a primary model and a fallback model, then press Test connection.</li>' +
      '<li>Come back here and try again.</li></ol></div>';
  }

  function isNotConfigured(data) {
    if (!data) return false;
    if (data.code === 'not_configured') return true;
    var text = ((data.error || '') + ' ' + (data.detail || '')).toLowerCase();
    return text.indexOf('not configured') !== -1 || text.indexOf('no api key') !== -1 || text.indexOf('api key') !== -1 && text.indexOf('missing') !== -1;
  }

  function recommendationHtml(rec) {
    if (!rec) return '<p class="muted">No recommendation returned.</p>';
    var evidence = asArray(rec.evidence);
    var html = '<div class="item rec"><h3>Recommendation</h3>' +
      '<p>' + esc(rec.recommendation || rec.text || 'No recommendation text returned.') + '</p>';
    if (rec.reasoning) html += '<h4>Reasoning</h4><p>' + esc(rec.reasoning) + '</p>';
    if (evidence.length) {
      html += '<h4>Evidence</h4><ul class="evidence">' + evidence.map(function (e) {
        return '<li>' + esc(typeof e === 'string' ? e : (e.text || e.label || JSON.stringify(e))) + '</li>';
      }).join('') + '</ul>';
    }
    if (rec.nextAction || rec.next_action) html += '<p><strong>Next action:</strong> ' + esc(rec.nextAction || rec.next_action) + '</p>';
    if (rec.draft) html += '<h4>Draft</h4><div class="draft-text">' + esc(rec.draft) + '</div>';
    if (rec.id) {
      html += '<div class="row">' +
        '<button class="btn small" type="button" data-feedback="done" data-id="' + esc(rec.id) + '">Mark done</button>' +
        '<button class="btn small" type="button" data-feedback="ignored" data-id="' + esc(rec.id) + '">Mark ignored</button>' +
        '<button class="btn small" type="button" data-feedback="not_useful" data-id="' + esc(rec.id) + '">Not useful</button>' +
        '<span class="muted feedback-status"></span></div>';
    } else {
      html += '<p class="muted">Feedback buttons need a saved recommendation id. This recommendation was not saved with one, so feedback cannot be recorded for it.</p>';
    }
    return html + '</div>';
  }

  document.addEventListener('click', async function (ev) {
    var btn = ev.target.closest('[data-feedback]');
    if (!btn) return;
    var statusEl = btn.parentElement.querySelector('.feedback-status');
    setBusy(btn, true, 'Saving...');
    try {
      await api('/api/recommendations/' + encodeURIComponent(btn.dataset.id) + '/feedback', {
        method: 'POST', body: { status: btn.dataset.feedback }
      });
      if (statusEl) statusEl.textContent = 'Saved as ' + btn.dataset.feedback + '.';
      btn.parentElement.querySelectorAll('[data-feedback]').forEach(function (b) { b.disabled = true; });
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Could not save feedback: ' + e.message;
    } finally {
      setBusy(btn, false);
    }
  });

  async function loadProspectsCache() {
    try {
      var data = await api('/api/prospects');
      state.prospects = asArray(data.prospects || data);
    } catch (e) { state.prospects = []; }
  }
  async function loadDraftsCache() {
    try {
      var data = await api('/api/drafts');
      state.drafts = asArray(data.drafts || data);
    } catch (e) { state.drafts = []; }
  }

  function prospectOptions(selectedId) {
    return state.prospects.map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (String(p.id) === String(selectedId) ? ' selected' : '') + '>' +
        esc(p.name || 'Unnamed') + (p.company ? ' (' + esc(p.company) + ')' : '') + '</option>';
    }).join('');
  }

  async function saveDraft(type, title, content) {
    var data = await api('/api/drafts', {
      method: 'POST',
      body: { type: type, title: title, content: content, status: 'pending' }
    });
    await loadDraftsCache();
    return data;
  }

  function draftQueueHtml() {
    if (!state.drafts.length) return '<div class="empty">No data yet. No drafts are waiting for approval.</div>';
    return '<div class="list">' + state.drafts.map(function (d) {
      var status = d.status || 'pending';
      return '<div class="item"><h4>' + esc(d.title || d.type || 'Draft') + '</h4>' +
        '<p><span class="tag">' + esc(d.type || '') + '</span><span class="tag ' +
        (status === 'approved' ? 'green' : status === 'rejected' ? 'red' : 'amber') + '">' + esc(status) + '</span></p>' +
        '<div class="draft-text">' + esc(d.content || d.draft || d.text || '') + '</div>' +
        (status === 'pending' ? '<div class="row">' +
          '<button class="btn small" type="button" data-approve="' + esc(d.id) + '">Approve</button>' +
          '<button class="btn small danger" type="button" data-reject="' + esc(d.id) + '">Reject</button></div>' : '') +
        '</div>';
    }).join('') + '</div>';
  }

  document.addEventListener('click', async function (ev) {
    var ap = ev.target.closest('[data-approve]');
    var rj = ev.target.closest('[data-reject]');
    var btn = ap || rj;
    if (!btn) return;
    var action = ap ? 'approve' : 'reject';
    var id = btn.dataset.approve || btn.dataset.reject;
    setBusy(btn, true, 'Saving...');
    try {
      await api('/api/drafts/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
      toast('Draft ' + action + 'd.');
      await loadDraftsCache();
      renderDraftQueue();
      if (state.currentPage === 'overview') loadOverview();
    } catch (e) {
      toast('Could not ' + action + ' draft: ' + e.message, true);
    } finally {
      setBusy(btn, false);
    }
  });

  function renderDraftQueue() {
    var el = $('draft-queue');
    if (el) el.innerHTML = draftQueueHtml();
  }

  /* ---------- Overview ---------- */

  async function loadOverview() {
    var w = $('overview-widgets');
    w.innerHTML = '<p class="muted">Loading overview.</p>';
    var results = await Promise.allSettled([
      api('/api/prospects'), api('/api/drafts'), api('/api/analytics')
    ]);
    var prospects = results[0].status === 'fulfilled' ? asArray(results[0].value.prospects || results[0].value) : [];
    var drafts = results[1].status === 'fulfilled' ? asArray(results[1].value.drafts || results[1].value) : [];
    var analytics = results[2].status === 'fulfilled' ? results[2].value : {};
    state.prospects = prospects;
    state.drafts = drafts;
    var due = prospects.filter(isDue);
    var approved = drafts.filter(function (d) { return (d.status || '') === 'approved'; }).length;
    var pending = drafts.filter(function (d) { return (d.status || 'pending') === 'pending'; }).length;
    var pendingRecs = (analytics.recommendationsPending !== undefined) ? analytics.recommendationsPending : pending;
    var widgets = [
      ['Prospects saved', prospects.length],
      ['Follow-ups due', due.length],
      ['Drafts created', drafts.length],
      ['Actions approved', approved],
      ['Recommendations pending', pendingRecs]
    ];
    w.innerHTML = widgets.map(function (x) {
      return '<div class="widget"><div class="num">' + esc(x[1]) + '</div><div class="label">' + esc(x[0]) + '</div></div>';
    }).join('');
    if (!prospects.length && !drafts.length) {
      w.insertAdjacentHTML('beforeend', '<p class="muted">No data yet. Add a prospect or generate a draft to see figures here.</p>');
    }
    var fw = $('overview-followups');
    if (!due.length) {
      fw.innerHTML = '<div class="empty">No data yet. No follow-ups are due.</div>';
    } else {
      fw.innerHTML = '<div class="list">' + due.map(function (p) {
        return '<div class="item"><strong>' + esc(p.name || 'Unnamed') + '</strong> ' +
          '<span class="muted">' + esc(p.company || '') + ' ' + esc(p.title || '') + '</span>' +
          '<p>Follow-up date: ' + esc(String(p.follow_up_date || p.followUpDate || '').slice(0, 10)) +
          (p.next_action || p.nextAction ? ' | Next action: ' + esc(p.next_action || p.nextAction) : '') + '</p></div>';
      }).join('') + '</div>';
    }
    var od = $('overview-drafts');
    var pend = drafts.filter(function (d) { return (d.status || 'pending') === 'pending'; });
    if (!pend.length) {
      od.innerHTML = '<div class="empty">No data yet. No drafts are waiting for approval.</div>';
    } else {
      od.innerHTML = '<div class="list">' + pend.slice(0, 5).map(function (d) {
        return '<div class="item"><strong>' + esc(d.title || d.type || 'Draft') + '</strong> ' +
          '<span class="tag">' + esc(d.type || '') + '</span>' +
          '<p>' + esc(String(d.content || d.draft || '').slice(0, 200)) + '</p></div>';
      }).join('') + '</div><p><a href="#" id="link-to-drafts">Open the approval queue</a></p>';
      var link = $('link-to-drafts');
      if (link) link.addEventListener('click', function (ev) { ev.preventDefault(); loadPage('content'); });
    }
  }

  /* ---------- AI Strategist ---------- */

  $('form-strategist').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var msg = $('strategist-message').value.trim();
    if (!msg) return;
    var btn = $('btn-strategist');
    var out = $('strategist-result');
    setBusy(btn, true, 'Thinking...');
    out.innerHTML = '<p class="muted">Asking the strategist...</p>';
    try {
      var data = await api('/api/strategist', { method: 'POST', body: { message: msg } });
      if (isNotConfigured(data)) {
        out.innerHTML = aiNotConfiguredHtml();
      } else if (data.error) {
        out.innerHTML = '<p class="error">The strategist returned an error: ' + esc(data.error) + (data.detail ? ' ' + esc(data.detail) : '') + '</p>';
      } else {
        out.innerHTML = recommendationHtml(data.recommendation ? data : data);
      }
    } catch (e) {
      out.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    } finally {
      setBusy(btn, false);
    }
  });

  /* ---------- Audience Intelligence ---------- */

  async function loadAudience() {
    var list = $('audience-list');
    list.innerHTML = '<p class="muted">Loading prioritized prospects.</p>';
    try {
      var data = await api('/api/prospects/prioritized');
      var ranked = asArray(data.prioritized || data.prospects || data);
      if (!ranked.length) {
        list.innerHTML = '<div class="empty">No data yet. Add prospects first, then the ranking will appear here with a reason for each rank.</div>';
      } else {
        list.innerHTML = '<div class="list">' + ranked.map(function (p, i) {
          var rank = p.rank !== undefined ? p.rank : i + 1;
          var reason = p.rank_reason || p.reason || p.relevance_reason || p.relevanceReason || '';
          return '<div class="item"><h3>#' + esc(rank) + ' ' + esc(p.name || 'Unnamed') + '</h3>' +
            '<p class="meta">' + esc(p.title || '') + (p.company ? ' at ' + esc(p.company) : '') +
            (p.relevance_score !== undefined ? ' | Relevance: ' + esc(p.relevance_score) : '') +
            (p.stage ? ' | Stage: ' + esc(p.stage) : '') + '</p>' +
            (reason ? '<p><strong>Why this rank:</strong> ' + esc(reason) + '</p>' : '<p class="muted">No rank reason was returned for this prospect.</p>') +
            (p.opportunity ? '<p><strong>Opportunity:</strong> ' + esc(p.opportunity) + '</p>' : '') + '</div>';
        }).join('') + '</div>';
      }
    } catch (e) {
      list.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    }
    var mem = $('audience-memory');
    mem.innerHTML = '<p class="muted">Loading audience definitions.</p>';
    try {
      var mdata = await api('/api/memory');
      var items = asArray(mdata.memory || mdata);
      var aud = items.filter(function (m) {
        var cat = (m.category || m.type || '').toLowerCase();
        var key = (m.key || m.label || '').toLowerCase();
        return cat.indexOf('audience') !== -1 || key.indexOf('audience') !== -1;
      });
      if (!aud.length) {
        mem.innerHTML = '<div class="empty">No data yet. No target audience definitions are saved. Add them under Strategy and Goals.</div>';
      } else {
        mem.innerHTML = '<div class="list">' + aud.map(function (m) {
          return '<div class="item"><strong>' + esc(m.key || m.label || m.category || 'Audience') + '</strong><p>' + esc(m.value || m.content || '') + '</p></div>';
        }).join('') + '</div>';
      }
    } catch (e) {
      mem.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    }
  }
  $('btn-refresh-audience').addEventListener('click', loadAudience);

  /* ---------- Prospects ---------- */

  function prospectToForm(p) {
    $('prospect-id').value = p.id || '';
    $('p-name').value = p.name || '';
    $('p-url').value = p.profile_url || p.profileUrl || '';
    $('p-company').value = p.company || '';
    $('p-title').value = p.title || '';
    $('p-industry').value = p.industry || '';
    $('p-expertise').value = p.expertise || '';
    $('p-source').value = p.source || '';
    $('p-score').value = (p.relevance_score !== undefined && p.relevance_score !== null) ? p.relevance_score : '';
    $('p-score-reason').value = p.relevance_reason || p.relevanceReason || '';
    $('p-opportunity').value = p.opportunity || '';
    $('p-stage').value = STAGES.indexOf(p.stage) !== -1 ? p.stage : 'Target';
    $('p-followup').value = String(p.follow_up_date || p.followUpDate || '').slice(0, 10);
    $('p-last').value = String(p.last_interaction || p.lastInteraction || '').slice(0, 10);
    $('p-next').value = p.next_action || p.nextAction || '';
    $('p-notes').value = p.notes || '';
    $('btn-save-prospect').textContent = 'Update prospect';
    $('prospect-form-status').textContent = 'Editing ' + (p.name || 'prospect') + '.';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function prospectFromForm() {
    return {
      name: $('p-name').value.trim(),
      profile_url: $('p-url').value.trim(),
      company: $('p-company').value.trim(),
      title: $('p-title').value.trim(),
      industry: $('p-industry').value.trim(),
      expertise: $('p-expertise').value.trim(),
      source: $('p-source').value.trim(),
      relevance_score: $('p-score').value === '' ? null : Number($('p-score').value),
      relevance_reason: $('p-score-reason').value.trim(),
      opportunity: $('p-opportunity').value.trim(),
      stage: $('p-stage').value,
      follow_up_date: $('p-followup').value || null,
      last_interaction: $('p-last').value || null,
      next_action: $('p-next').value.trim(),
      notes: $('p-notes').value.trim()
    };
  }

  function clearProspectForm() {
    $('form-prospect').reset();
    $('prospect-id').value = '';
    $('btn-save-prospect').textContent = 'Save prospect';
    $('prospect-form-status').textContent = '';
  }
  $('btn-clear-prospect').addEventListener('click', clearProspectForm);

  $('form-prospect').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var id = $('prospect-id').value;
    var btn = $('btn-save-prospect');
    setBusy(btn, true, 'Saving...');
    try {
      if (id) {
        await api('/api/prospects/' + encodeURIComponent(id), { method: 'PUT', body: prospectFromForm() });
        toast('Prospect updated.');
      } else {
        await api('/api/prospects', { method: 'POST', body: prospectFromForm() });
        toast('Prospect saved.');
      }
      clearProspectForm();
      await loadProspects();
    } catch (e) {
      toast('Could not save prospect: ' + e.message, true);
    } finally {
      setBusy(btn, false);
    }
  });

  async function loadProspects() {
    await loadProspectsCache();
    renderProspects();
  }

  function renderProspects() {
    var q = ($('prospect-search').value || '').toLowerCase();
    var stage = $('prospect-filter-stage').value;
    var list = state.prospects.filter(function (p) {
      var hay = ((p.name || '') + ' ' + (p.company || '') + ' ' + (p.title || '')).toLowerCase();
      if (q && hay.indexOf(q) === -1) return false;
      if (stage && p.stage !== stage) return false;
      return true;
    });
    var due = state.prospects.filter(isDue);
    var rem = $('prospect-reminders');
    if (!due.length) {
      rem.innerHTML = '<div class="empty">No data yet. No follow-ups are due.</div>';
    } else {
      rem.innerHTML = '<div class="list">' + due.map(function (p) {
        return '<div class="item"><strong>' + esc(p.name || 'Unnamed') + '</strong> ' +
          '<span class="muted">due ' + esc(String(p.follow_up_date || p.followUpDate || '').slice(0, 10)) + '</span>' +
          '<p>' + esc(p.next_action || p.nextAction || 'No next action recorded.') + '</p>' +
          '<button class="btn small" type="button" data-edit-prospect="' + esc(p.id) + '">Open</button></div>';
      }).join('') + '</div>';
    }
    var el = $('prospect-list');
    if (!state.prospects.length) {
      el.innerHTML = '<div class="empty">No data yet. Add your first prospect with the form above. The seeded example prospect will appear here once the backend seeds it.</div>';
    } else if (!list.length) {
      el.innerHTML = '<div class="empty">No prospects match this search or filter.</div>';
    } else {
      el.innerHTML = '<div class="list">' + list.map(function (p) {
        var seeded = p.seeded || p.is_seed || p.source === 'seed' || p.is_example;
        return '<div class="item"><h3>' + esc(p.name || 'Unnamed') + (seeded ? ' <span class="tag">Seeded example</span>' : '') + '</h3>' +
          '<p class="meta">' + esc(p.title || '') + (p.company ? ' at ' + esc(p.company) : '') +
          (p.profile_url || p.profileUrl ? ' | <a href="' + esc(p.profile_url || p.profileUrl) + '" target="_blank" rel="noopener">Profile</a>' : '') + '</p>' +
          '<p><span class="tag">' + esc(p.stage || 'Target') + '</span>' +
          (p.relevance_score !== undefined && p.relevance_score !== null ? '<span class="tag">Relevance ' + esc(p.relevance_score) + '</span>' : '') +
          (p.industry ? '<span class="tag">' + esc(p.industry) + '</span>' : '') + '</p>' +
          (p.relevance_reason || p.relevanceReason ? '<p><strong>Why this score:</strong> ' + esc(p.relevance_reason || p.relevanceReason) + '</p>' : '') +
          (p.opportunity ? '<p><strong>Opportunity:</strong> ' + esc(p.opportunity) + '</p>' : '') +
          (p.next_action || p.nextAction ? '<p><strong>Next action:</strong> ' + esc(p.next_action || p.nextAction) + '</p>' : '') +
          (p.follow_up_date || p.followUpDate ? '<p><strong>Follow-up:</strong> ' + esc(String(p.follow_up_date || p.followUpDate).slice(0, 10)) + '</p>' : '') +
          (p.notes ? '<p>' + esc(p.notes) + '</p>' : '') +
          '<div class="row">' +
          '<button class="btn small" type="button" data-edit-prospect="' + esc(p.id) + '">Edit</button>' +
          '<button class="btn small" type="button" data-crm-prospect="' + esc(p.id) + '">Open in CRM</button>' +
          '<button class="btn small danger" type="button" data-delete-prospect="' + esc(p.id) + '">Delete</button>' +
          '</div></div>';
      }).join('') + '</div>';
    }
    var pipe = $('prospect-pipeline');
    pipe.innerHTML = '<div class="pipeline">' + STAGES.map(function (s) {
      var inStage = state.prospects.filter(function (p) { return (p.stage || 'Target') === s; });
      return '<div class="stage-col"><h4>' + esc(s) + ' (' + inStage.length + ')</h4>' +
        (inStage.length ? inStage.map(function (p) {
          return '<div class="mini">' + esc(p.name || 'Unnamed') + '</div>';
        }).join('') : '<div class="mini muted">None</div>') + '</div>';
    }).join('') + '</div>';
  }

  $('prospect-search').addEventListener('input', renderProspects);
  $('prospect-filter-stage').addEventListener('change', renderProspects);
  $('btn-refresh-prospects').addEventListener('click', loadProspects);

  document.addEventListener('click', async function (ev) {
    var edit = ev.target.closest('[data-edit-prospect]');
    if (edit) {
      var p = state.prospects.find(function (x) { return String(x.id) === String(edit.dataset.editProspect); });
      if (p) prospectToForm(p);
      return;
    }
    var crm = ev.target.closest('[data-crm-prospect]');
    if (crm) {
      loadPage('crm');
      setTimeout(function () {
        $('crm-select').value = crm.dataset.crmProspect;
        loadCrmDetail();
      }, 50);
      return;
    }
    var del = ev.target.closest('[data-delete-prospect]');
    if (del) {
      var name = (state.prospects.find(function (x) { return String(x.id) === String(del.dataset.deleteProspect); }) || {}).name || 'this prospect';
      if (!window.confirm('Delete ' + name + '? This cannot be undone.')) return;
      setBusy(del, true, 'Deleting...');
      try {
        await api('/api/prospects/' + encodeURIComponent(del.dataset.deleteProspect), { method: 'DELETE' });
        toast('Prospect deleted.');
        await loadProspects();
      } catch (e) {
        toast('Could not delete prospect: ' + e.message, true);
      } finally {
        setBusy(del, false);
      }
    }
  });

  /* ---------- Relationship CRM ---------- */

  async function loadCrm() {
    await loadProspectsCache();
    var sel = $('crm-select');
    var current = sel.value;
    sel.innerHTML = '<option value="">Select a prospect</option>' + prospectOptions(current);
  }

  $('crm-select').addEventListener('change', loadCrmDetail);

  async function loadCrmDetail() {
    var id = $('crm-select').value;
    var detail = $('crm-detail');
    if (!id) {
      detail.innerHTML = '<p class="muted">Select a prospect to see their notes and interaction log.</p>';
      $('crm-forms').hidden = true;
      return;
    }
    detail.innerHTML = '<p class="muted">Loading prospect detail.</p>';
    try {
      var p = await api('/api/prospects/' + encodeURIComponent(id));
      p = p.prospect || p;
      var notes = asArray(p.notes_list || p.notesList || []);
      var interactions = asArray(p.interactions || []);
      try {
        var ndata = await api('/api/prospects/' + encodeURIComponent(id) + '/notes');
        notes = asArray(ndata.notes || ndata);
      } catch (e) { /* keep notes embedded in the prospect record */ }
      var notesText = p.notes;
      detail.innerHTML = '<div class="item"><h3>' + esc(p.name || 'Unnamed') + '</h3>' +
        '<p class="meta">' + esc(p.title || '') + (p.company ? ' at ' + esc(p.company) : '') +
        ' | Stage: ' + esc(p.stage || 'Target') +
        (p.profile_url || p.profileUrl ? ' | <a href="' + esc(p.profile_url || p.profileUrl) + '" target="_blank" rel="noopener">Profile</a>' : '') + '</p>' +
        (p.opportunity ? '<p><strong>Opportunity:</strong> ' + esc(p.opportunity) + '</p>' : '') +
        (p.next_action || p.nextAction ? '<p><strong>Next action:</strong> ' + esc(p.next_action || p.nextAction) + '</p>' : '') +
        (p.follow_up_date || p.followUpDate ? '<p><strong>Follow-up:</strong> ' + esc(String(p.follow_up_date || p.followUpDate).slice(0, 10)) + '</p>' : '') +
        '</div>' +
        '<h3>Notes</h3>' +
        (notes.length ? '<div class="list">' + notes.map(function (n) {
          return '<div class="item"><p>' + esc(n.text || n.content || n.note || '') + '</p>' +
            '<p class="meta">' + esc(n.created_at || n.createdAt || n.date || '') + '</p></div>';
        }).join('') + '</div>' : '') +
        (notesText && !notes.length ? '<div class="item"><p>' + esc(notesText) + '</p></div>' : '') +
        (!notes.length && !notesText ? '<div class="empty">No data yet. No notes for this prospect.</div>' : '') +
        '<h3>Interaction log</h3>' +
        (interactions.length ? '<div class="list">' + interactions.map(function (x) {
          return '<div class="item"><p><span class="tag">' + esc(x.type || 'Interaction') + '</span> ' + esc(x.summary || x.text || x.note || '') + '</p>' +
            '<p class="meta">' + esc(x.date || x.created_at || x.createdAt || '') + '</p></div>';
        }).join('') + '</div>' : '<div class="empty">No data yet. No interactions logged for this prospect.</div>');
      $('crm-forms').hidden = false;
    } catch (e) {
      detail.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
      $('crm-forms').hidden = true;
    }
  }

  $('form-interaction').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var id = $('crm-select').value;
    if (!id) { toast('Select a prospect first.', true); return; }
    var btn = $('btn-add-interaction');
    setBusy(btn, true, 'Adding...');
    try {
      await api('/api/prospects/' + encodeURIComponent(id) + '/interactions', {
        method: 'POST',
        body: { type: $('i-type').value, date: $('i-date').value || todayStr(), summary: $('i-summary').value.trim() }
      });
      $('i-summary').value = '';
      $('i-date').value = '';
      toast('Interaction added.');
      loadCrmDetail();
    } catch (e) {
      toast('Could not add interaction: ' + e.message, true);
    } finally {
      setBusy(btn, false);
    }
  });

  $('form-note').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var id = $('crm-select').value;
    if (!id) { toast('Select a prospect first.', true); return; }
    var btn = $('btn-add-note');
    setBusy(btn, true, 'Adding...');
    try {
      await api('/api/prospects/' + encodeURIComponent(id) + '/notes', {
        method: 'POST',
        body: { text: $('n-text').value.trim(), content: $('n-text').value.trim() }
      });
      $('n-text').value = '';
      toast('Note added.');
      loadCrmDetail();
    } catch (e) {
      toast('Could not add note: ' + e.message, true);
    } finally {
      setBusy(btn, false);
    }
  });

  /* ---------- Conversations ---------- */

  async function loadConversationProspects() {
    await loadProspectsCache();
    $('conv-prospect').innerHTML = '<option value="">No prospect selected</option>' + prospectOptions('');
  }

  $('form-conversation').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = $('btn-summarise');
    var out = $('conversation-result');
    var text = $('conv-text').value.trim();
    var pid = $('conv-prospect').value;
    var prospect = state.prospects.find(function (p) { return String(p.id) === String(pid); });
    setBusy(btn, true, 'Working...');
    out.innerHTML = '<p class="muted">Summarising and drafting a follow-up...</p>';
    try {
      var data = await api('/api/ai/draft', {
        method: 'POST',
        body: { type: 'conversation_followup', inputs: { conversation: text, prospect: prospect || null } }
      });
      if (isNotConfigured(data)) { out.innerHTML = aiNotConfiguredHtml(); return; }
      if (data.error) { out.innerHTML = '<p class="error">' + esc(data.error) + (data.detail ? ' ' + esc(data.detail) : '') + '</p>'; return; }
      var summary = data.recommendation || data.summary || '';
      var draft = data.draft || '';
      out.innerHTML = '<div class="item rec"><h3>Summary</h3><p>' + esc(summary || 'No summary returned.') + '</p>' +
        (data.reasoning ? '<h4>Reasoning</h4><p>' + esc(data.reasoning) + '</p>' : '') +
        (draft ? '<h4>Suggested follow-up draft</h4><div class="draft-text">' + esc(draft) + '</div>' : '<p class="muted">No follow-up draft was returned.</p>') +
        (draft ? '<button class="btn primary" type="button" id="btn-queue-conv">Send to approval queue</button> <span class="muted" id="conv-queue-status"></span>' : '') +
        '</div>';
      var qbtn = $('btn-queue-conv');
      if (qbtn) qbtn.addEventListener('click', async function () {
        setBusy(qbtn, true, 'Saving...');
        try {
          await saveDraft('follow_up', 'Follow-up for ' + (prospect ? prospect.name : 'conversation'), draft);
          $('conv-queue-status').textContent = 'Saved to the approval queue.';
          toast('Draft sent to the approval queue.');
        } catch (e) {
          $('conv-queue-status').textContent = 'Could not save draft: ' + e.message;
        } finally {
          setBusy(qbtn, false);
        }
      });
    } catch (e) {
      out.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    } finally {
      setBusy(btn, false);
    }
  });

  /* ---------- Content Studio ---------- */

  async function loadContentPage() {
    await loadProspectsCache();
    await loadDraftsCache();
    $('outreach-prospect').innerHTML = '<option value="">Select a prospect</option>' + prospectOptions('');
    renderDraftQueue();
  }
  $('btn-refresh-drafts').addEventListener('click', async function () {
    await loadDraftsCache();
    renderDraftQueue();
  });

  function draftResultHtml(container, title, data) {
    if (isNotConfigured(data)) { container.innerHTML = aiNotConfiguredHtml(); return; }
    if (data.error) { container.innerHTML = '<p class="error">' + esc(data.error) + (data.detail ? ' ' + esc(data.detail) : '') + '</p>'; return; }
    var draft = data.draft || data.recommendation || '';
    if (!draft) { container.innerHTML = '<p class="muted">No draft was returned.</p>'; return; }
    container.innerHTML = '<div class="item rec"><h3>' + esc(title) + '</h3>' +
      (data.reasoning ? '<p>' + esc(data.reasoning) + '</p>' : '') +
      '<div class="draft-text">' + esc(draft) + '</div>' +
      '<button class="btn primary" type="button" data-queue-draft>Send to approval queue</button> <span class="muted queue-status"></span></div>';
    var qbtn = container.querySelector('[data-queue-draft]');
    qbtn.addEventListener('click', async function () {
      setBusy(qbtn, true, 'Saving...');
      try {
        await saveDraft(container.dataset.draftType || 'post', title, draft);
        container.querySelector('.queue-status').textContent = 'Saved to the approval queue.';
        toast('Draft sent to the approval queue.');
        renderDraftQueue();
      } catch (e) {
        container.querySelector('.queue-status').textContent = 'Could not save draft: ' + e.message;
      } finally {
        setBusy(qbtn, false);
      }
    });
  }

  $('form-post').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = $('btn-gen-post');
    var out = $('post-result');
    out.dataset.draftType = 'post';
    setBusy(btn, true, 'Generating...');
    out.innerHTML = '<p class="muted">Generating post draft...</p>';
    try {
      var data = await api('/api/ai/draft', {
        method: 'POST',
        body: { type: 'post', inputs: { topic: $('post-topic').value.trim(), angle: $('post-angle').value.trim(), mode: $('post-mode').value } }
      });
      draftResultHtml(out, 'Post draft: ' + $('post-topic').value.trim(), data);
    } catch (e) {
      out.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    } finally {
      setBusy(btn, false);
    }
  });

  $('form-comment').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = $('btn-gen-comment');
    var out = $('comment-result');
    out.dataset.draftType = 'comment';
    setBusy(btn, true, 'Generating...');
    out.innerHTML = '<p class="muted">Generating comment draft...</p>';
    try {
      var data = await api('/api/ai/draft', {
        method: 'POST',
        body: { type: 'comment', inputs: { postText: $('comment-post').value.trim(), mode: $('comment-mode').value } }
      });
      draftResultHtml(out, 'Comment draft', data);
    } catch (e) {
      out.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    } finally {
      setBusy(btn, false);
    }
  });

  $('form-outreach').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = $('btn-gen-outreach');
    var out = $('outreach-result');
    var kind = $('outreach-kind').value;
    out.dataset.draftType = kind === 'connection' ? 'connection_message' : 'follow_up';
    var prospect = state.prospects.find(function (p) { return String(p.id) === String($('outreach-prospect').value); });
    if (!prospect) { toast('Select a prospect first.', true); return; }
    setBusy(btn, true, 'Generating...');
    out.innerHTML = '<p class="muted">Generating message draft...</p>';
    try {
      var data = await api('/api/ai/draft', {
        method: 'POST',
        body: { type: kind, inputs: { prospect: prospect, context: $('outreach-context').value.trim() } }
      });
      draftResultHtml(out, (kind === 'connection' ? 'Connection message for ' : 'Follow-up message for ') + (prospect.name || ''), data);
    } catch (e) {
      out.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    } finally {
      setBusy(btn, false);
    }
  });

  /* ---------- Profile Optimizer ---------- */

  function profileInputs() {
    return {
      name: $('pf-name').value.trim(),
      title: $('pf-title').value.trim(),
      linkedin: $('pf-linkedin').value.trim(),
      portfolio: $('pf-portfolio').value.trim(),
      github: $('pf-github').value.trim(),
      services: $('pf-services').value.trim(),
      expertise: $('pf-expertise').value.trim(),
      objectives: $('pf-objectives').value.trim(),
      projects: $('pf-projects').value.trim(),
      achievements: $('pf-achievements').value.trim(),
      certifications: $('pf-certs').value.trim(),
      industries: $('pf-industries').value.trim(),
      markets: $('pf-markets').value.trim(),
      audience: $('pf-audience').value.trim()
    };
  }

  async function generateProfileSection(type, label, btn) {
    var out = $('profile-result');
    setBusy(btn, true, 'Generating...');
    out.innerHTML = '<p class="muted">Generating ' + esc(label.toLowerCase()) + '...</p>';
    try {
      var data = await api('/api/ai/draft', { method: 'POST', body: { type: type, inputs: profileInputs() } });
      if (isNotConfigured(data)) { out.innerHTML = aiNotConfiguredHtml(); return; }
      if (data.error) { out.innerHTML = '<p class="error">' + esc(data.error) + (data.detail ? ' ' + esc(data.detail) : '') + '</p>'; return; }
      var draft = data.draft || data.recommendation || '';
      if (!draft) { out.innerHTML = '<p class="muted">No draft was returned.</p>'; return; }
      out.innerHTML = '<div class="item rec"><h3>' + esc(label) + '</h3>' +
        '<p class="muted">Edit below, then save it to the approval queue.</p>' +
        '<textarea id="profile-edit" rows="8">' + esc(draft) + '</textarea>' +
        '<div class="row"><button class="btn primary" type="button" id="btn-queue-profile">Save to approval queue</button>' +
        '<span class="muted" id="profile-queue-status"></span></div></div>';
      $('btn-queue-profile').addEventListener('click', async function () {
        var qb = $('btn-queue-profile');
        setBusy(qb, true, 'Saving...');
        try {
          await saveDraft(type, label + ' for ' + profileInputs().name, $('profile-edit').value);
          $('profile-queue-status').textContent = 'Saved to the approval queue.';
          toast('Draft sent to the approval queue.');
        } catch (e) {
          $('profile-queue-status').textContent = 'Could not save draft: ' + e.message;
        } finally {
          setBusy(qb, false);
        }
      });
    } catch (e) {
      out.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    } finally {
      setBusy(btn, false);
    }
  }

  $('btn-gen-headline').addEventListener('click', function () { generateProfileSection('profile_headline', 'Headline', this); });
  $('btn-gen-about').addEventListener('click', function () { generateProfileSection('profile_about', 'About section', this); });
  $('btn-gen-experience').addEventListener('click', function () { generateProfileSection('profile_experience', 'Experience bullets', this); });
  $('btn-gen-featured').addEventListener('click', function () { generateProfileSection('profile_featured', 'Featured strategy', this); });
  $('btn-gen-skills').addEventListener('click', function () { generateProfileSection('profile_skills', 'Skills', this); });
  $('btn-gen-checklist').addEventListener('click', function () { generateProfileSection('profile_checklist', 'Profile checklist', this); });

  /* ---------- Browser Extension page ---------- */

  $('btn-show-token').addEventListener('click', function () {
    var input = $('ext-token');
    var isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    this.textContent = isHidden ? 'Hide' : 'Show';
  });
  $('btn-copy-token').addEventListener('click', async function () {
    var token = $('ext-token').value;
    if (!token) { toast('No token to copy. Sign in first.', true); return; }
    try {
      await navigator.clipboard.writeText(token);
      toast('Token copied. Paste it into the extension popup.');
    } catch (e) {
      $('ext-token').select();
      toast('Copy failed. The token field is selected, copy it by hand.', true);
    }
  });
  $('btn-test-ext-backend').addEventListener('click', async function () {
    var btn = this;
    var status = $('ext-test-status');
    setBusy(btn, true, 'Testing...');
    try {
      var url = ($('ext-url').value.trim() || 'http://localhost:3000').replace(/\/$/, '');
      var res = await fetch(url + '/api/auth/status');
      if (!res.ok) throw new Error('Backend answered with status ' + res.status);
      await res.json();
      status.textContent = 'Backend reachable at ' + url + '.';
    } catch (e) {
      status.textContent = 'Backend not reachable: ' + e.message;
    } finally {
      setBusy(btn, false);
    }
  });

  /* ---------- Strategy and Goals ---------- */

  function clearGoalForm() {
    $('form-goal').reset();
    $('goal-id').value = '';
    $('btn-save-goal').textContent = 'Save goal';
  }
  $('btn-clear-goal').addEventListener('click', clearGoalForm);

  function clearMemoryForm() {
    $('form-memory').reset();
    $('memory-id').value = '';
    $('btn-save-memory').textContent = 'Save memory item';
  }
  $('btn-clear-memory').addEventListener('click', clearMemoryForm);

  async function loadStrategy() {
    var gl = $('goal-list');
    gl.innerHTML = '<p class="muted">Loading goals.</p>';
    try {
      var gdata = await api('/api/goals');
      state.goals = asArray(gdata.goals || gdata);
      if (!state.goals.length) {
        gl.innerHTML = '<div class="empty">No data yet. No goals saved.</div>';
      } else {
        gl.innerHTML = '<div class="list">' + state.goals.map(function (g) {
          return '<div class="item"><h3>' + esc(g.title || g.name || 'Goal') + '</h3>' +
            '<p class="meta">Status: ' + esc(g.status || 'Active') +
            (g.target ? ' | Target: ' + esc(g.target) : '') +
            (g.deadline ? ' | Deadline: ' + esc(String(g.deadline).slice(0, 10)) : '') + '</p>' +
            (g.description ? '<p>' + esc(g.description) + '</p>' : '') +
            '<div class="row"><button class="btn small" type="button" data-edit-goal="' + esc(g.id) + '">Edit</button>' +
            '<button class="btn small danger" type="button" data-delete-goal="' + esc(g.id) + '">Delete</button></div></div>';
        }).join('') + '</div>';
      }
    } catch (e) {
      gl.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    }
    var ml = $('memory-list');
    ml.innerHTML = '<p class="muted">Loading memory.</p>';
    try {
      var mdata = await api('/api/memory');
      state.memory = asArray(mdata.memory || mdata);
      if (!state.memory.length) {
        ml.innerHTML = '<div class="empty">No data yet. No memory saved. The strategist has nothing to read yet.</div>';
      } else {
        ml.innerHTML = '<div class="list">' + state.memory.map(function (m) {
          return '<div class="item"><h3>' + esc(m.key || m.label || 'Item') + '</h3>' +
            '<p><span class="tag">' + esc(m.category || m.type || 'Other') + '</span></p>' +
            '<p>' + esc(m.value || m.content || '') + '</p>' +
            '<div class="row"><button class="btn small" type="button" data-edit-memory="' + esc(m.id) + '">Edit</button>' +
            '<button class="btn small danger" type="button" data-delete-memory="' + esc(m.id) + '">Delete</button></div></div>';
        }).join('') + '</div>';
      }
    } catch (e) {
      ml.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    }
  }

  $('form-goal').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var id = $('goal-id').value;
    var btn = $('btn-save-goal');
    var body = {
      title: $('g-title').value.trim(),
      target: $('g-target').value.trim(),
      deadline: $('g-deadline').value || null,
      status: $('g-status').value,
      description: $('g-desc').value.trim()
    };
    setBusy(btn, true, 'Saving...');
    try {
      if (id) await api('/api/goals/' + encodeURIComponent(id), { method: 'PUT', body: body });
      else await api('/api/goals', { method: 'POST', body: body });
      toast(id ? 'Goal updated.' : 'Goal saved.');
      clearGoalForm();
      loadStrategy();
    } catch (e) {
      toast('Could not save goal: ' + e.message, true);
    } finally {
      setBusy(btn, false);
    }
  });

  $('form-memory').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var id = $('memory-id').value;
    var btn = $('btn-save-memory');
    var body = {
      category: $('m-category').value,
      key: $('m-key').value.trim(),
      value: $('m-value').value.trim(),
      content: $('m-value').value.trim()
    };
    setBusy(btn, true, 'Saving...');
    try {
      if (id) await api('/api/memory/' + encodeURIComponent(id), { method: 'PUT', body: body });
      else await api('/api/memory', { method: 'POST', body: body });
      toast(id ? 'Memory item updated.' : 'Memory item saved.');
      clearMemoryForm();
      loadStrategy();
    } catch (e) {
      toast('Could not save memory item: ' + e.message, true);
    } finally {
      setBusy(btn, false);
    }
  });

  document.addEventListener('click', async function (ev) {
    var eg = ev.target.closest('[data-edit-goal]');
    if (eg) {
      var g = state.goals.find(function (x) { return String(x.id) === String(eg.dataset.editGoal); });
      if (!g) return;
      $('goal-id').value = g.id;
      $('g-title').value = g.title || g.name || '';
      $('g-target').value = g.target || '';
      $('g-deadline').value = String(g.deadline || '').slice(0, 10);
      $('g-status').value = g.status || 'Active';
      $('g-desc').value = g.description || '';
      $('btn-save-goal').textContent = 'Update goal';
      return;
    }
    var dg = ev.target.closest('[data-delete-goal]');
    if (dg) {
      if (!window.confirm('Delete this goal?')) return;
      try {
        await api('/api/goals/' + encodeURIComponent(dg.dataset.deleteGoal), { method: 'DELETE' });
        toast('Goal deleted.');
        loadStrategy();
      } catch (e) { toast('Could not delete goal: ' + e.message, true); }
      return;
    }
    var em = ev.target.closest('[data-edit-memory]');
    if (em) {
      var m = state.memory.find(function (x) { return String(x.id) === String(em.dataset.editMemory); });
      if (!m) return;
      $('memory-id').value = m.id;
      $('m-category').value = m.category || m.type || 'Other';
      $('m-key').value = m.key || m.label || '';
      $('m-value').value = m.value || m.content || '';
      $('btn-save-memory').textContent = 'Update memory item';
      return;
    }
    var dm = ev.target.closest('[data-delete-memory]');
    if (dm) {
      if (!window.confirm('Delete this memory item? The strategist will no longer read it.')) return;
      try {
        await api('/api/memory/' + encodeURIComponent(dm.dataset.deleteMemory), { method: 'DELETE' });
        toast('Memory item deleted.');
        loadStrategy();
      } catch (e) { toast('Could not delete memory item: ' + e.message, true); }
    }
  });

  /* ---------- Analytics ---------- */

  function barChart(title, entries) {
    if (!entries.length) return '<h3>' + esc(title) + '</h3><div class="empty">No data yet.</div>';
    var max = Math.max.apply(null, entries.map(function (e) { return e[1]; }).concat([1]));
    return '<h3>' + esc(title) + '</h3><div class="bar-chart">' + entries.map(function (e) {
      var pct = Math.round((e[1] / max) * 100);
      return '<div class="bar-row"><span>' + esc(e[0]) + '</span>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
        '<strong>' + esc(e[1]) + '</strong></div>';
    }).join('') + '</div>';
  }

  async function loadAnalytics() {
    var body = $('analytics-body');
    body.innerHTML = '<p class="muted">Loading analytics.</p>';
    try {
      var data = await api('/api/analytics');
      var byStage = data.prospectsByStage || data.prospects_by_stage || data.byStage || {};
      var byType = data.draftsByType || data.drafts_by_type || data.byType || {};
      var stageEntries = Object.keys(byStage).map(function (k) { return [k, Number(byStage[k]) || 0]; });
      if (!stageEntries.length && state.prospects.length) {
        stageEntries = STAGES.map(function (s) {
          return [s, state.prospects.filter(function (p) { return (p.stage || 'Target') === s; }).length];
        }).filter(function (e) { return e[1] > 0; });
      }
      var typeEntries = Object.keys(byType).map(function (k) { return [k, Number(byType[k]) || 0]; });
      var due = data.followUpsDue !== undefined ? data.followUpsDue : data.follow_ups_due;
      if (due === undefined) due = state.prospects.filter(isDue).length;
      var totalProspects = data.totalProspects !== undefined ? data.totalProspects : state.prospects.length;
      var totalDrafts = data.totalDrafts !== undefined ? data.totalDrafts : state.drafts.length;
      body.innerHTML =
        '<div class="grid widgets">' +
        '<div class="widget"><div class="num">' + esc(totalProspects) + '</div><div class="label">Prospects saved</div></div>' +
        '<div class="widget"><div class="num">' + esc(due) + '</div><div class="label">Follow-ups due</div></div>' +
        '<div class="widget"><div class="num">' + esc(totalDrafts) + '</div><div class="label">Drafts created</div></div>' +
        '</div>' +
        barChart('Prospects by stage', stageEntries) +
        barChart('Drafts by type', typeEntries) +
        '<p class="muted fineprint">These charts are computed only from app records. They are not LinkedIn analytics.</p>';
    } catch (e) {
      body.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    }
  }
  $('btn-refresh-analytics').addEventListener('click', async function () {
    await loadProspectsCache();
    await loadDraftsCache();
    loadAnalytics();
  });

  /* ---------- Model Configuration ---------- */

  function modelOptions(list, selected) {
    return list.map(function (m) {
      var id = m.id || m.name;
      return '<option value="' + esc(id) + '"' + (id === selected ? ' selected' : '') + '>' +
        esc(m.name || id) + (m.free ? ' (free)' : '') + '</option>';
    }).join('');
  }

  async function loadConfig() {
    var summary = $('config-summary');
    summary.textContent = 'Loading configuration.';
    try {
      var cfg = await api('/api/config');
      state.config = cfg;
      $('cfg-temp').value = cfg.temperature !== undefined ? cfg.temperature : 0.7;
      $('cfg-tokens').value = cfg.max_tokens !== undefined ? cfg.max_tokens : 4000;
      summary.textContent = cfg.keyConfigured
        ? 'API key: configured. Primary model: ' + (cfg.primary_model || 'not set') + '. Fallback model: ' + (cfg.fallback_model || 'not set') + '.'
        : 'API key: not configured. Save a key above before the AI can answer.';
    } catch (e) {
      summary.textContent = 'Could not load configuration: ' + e.message;
    }
    await loadModels();
    loadErrors();
  }

  async function loadModels() {
    try {
      var data = await api('/api/models');
      state.models = asArray(data.models || data);
    } catch (e) {
      state.models = [];
      $('cfg-primary').innerHTML = '';
      $('cfg-fallback').innerHTML = '';
      return;
    }
    applyModelFilter();
  }

  function applyModelFilter() {
    var freeOnly = $('cfg-free-only').checked;
    var list = freeOnly ? state.models.filter(function (m) { return m.free; }) : state.models;
    var cfg = state.config || {};
    $('cfg-primary').innerHTML = modelOptions(list, cfg.primary_model);
    $('cfg-fallback').innerHTML = modelOptions(list, cfg.fallback_model);
    if (!list.length) {
      $('cfg-primary').innerHTML = '<option value="">No models available</option>';
      $('cfg-fallback').innerHTML = '<option value="">No models available</option>';
    }
  }
  $('cfg-free-only').addEventListener('change', applyModelFilter);

  $('form-key').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = $('btn-save-key');
    var status = $('key-status');
    var key = $('cfg-key').value.trim();
    if (!key) { status.textContent = 'Paste a key first.'; return; }
    setBusy(btn, true, 'Saving...');
    try {
      await api('/api/config/key', { method: 'POST', body: { key: key } });
      $('cfg-key').value = '';
      status.textContent = 'Key saved.';
      toast('API key saved.');
      refreshStatusPills();
      loadConfig();
    } catch (e) {
      status.textContent = 'Could not save key: ' + e.message;
    } finally {
      setBusy(btn, false);
    }
  });

  $('form-config').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = $('btn-save-config');
    var status = $('config-status');
    setBusy(btn, true, 'Saving...');
    try {
      await api('/api/config', {
        method: 'PUT',
        body: {
          primary_model: $('cfg-primary').value,
          fallback_model: $('cfg-fallback').value,
          temperature: Number($('cfg-temp').value),
          max_tokens: Number($('cfg-tokens').value)
        }
      });
      status.textContent = 'Configuration saved.';
      toast('Configuration saved.');
      loadConfig();
    } catch (e) {
      status.textContent = 'Could not save configuration: ' + e.message;
    } finally {
      setBusy(btn, false);
    }
  });

  $('btn-test-config').addEventListener('click', async function () {
    var btn = $('btn-test-config');
    var status = $('config-status');
    setBusy(btn, true, 'Testing...');
    try {
      var data = await api('/api/config/test', { method: 'POST' });
      if (data.ok) {
        status.textContent = 'Connection works. Models available: ' + (data.modelCount !== undefined ? data.modelCount : 'unknown') + '.';
        toast('Connection test passed.');
      } else {
        status.textContent = 'Test failed: ' + (data.error || 'unknown error');
      }
    } catch (e) {
      status.textContent = 'Test failed: ' + e.message;
    } finally {
      setBusy(btn, false);
    }
  });

  async function loadErrors() {
    var el = $('error-log');
    el.innerHTML = '<p class="muted">Loading error log.</p>';
    try {
      var data = await api('/api/errors');
      var items = asArray(data.errors || data);
      if (!items.length) {
        el.innerHTML = '<div class="empty">No data yet. No errors logged.</div>';
        return;
      }
      el.innerHTML = '<table class="log"><thead><tr><th>When</th><th>Error</th><th>Detail</th></tr></thead><tbody>' +
        items.slice(0, 50).map(function (x) {
          return '<tr><td>' + esc(x.created_at || x.createdAt || x.time || x.date || '') + '</td>' +
            '<td>' + esc(x.error || x.message || x.code || '') + '</td>' +
            '<td>' + esc(x.detail || x.context || x.endpoint || '') + '</td></tr>';
        }).join('') + '</tbody></table>';
    } catch (e) {
      el.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    }
  }
  $('btn-refresh-errors').addEventListener('click', loadErrors);

  /* ---------- Settings ---------- */

  $('kill-toggle').addEventListener('change', async function () {
    var enabled = $('kill-toggle').checked;
    var note = $('kill-note');
    try {
      await api('/api/killswitch', { method: 'POST', body: { enabled: enabled } });
      state.killswitch = enabled;
      note.textContent = enabled
        ? 'Kill switch is ON. AI actions and extension actions are stopped.'
        : 'Kill switch is off. AI actions are allowed.';
      refreshStatusPills();
      toast(enabled ? 'Kill switch turned on.' : 'Kill switch turned off.');
    } catch (e) {
      $('kill-toggle').checked = !enabled;
      note.textContent = 'Could not change kill switch: ' + e.message;
    }
  });

  async function loadSettings() {
    await refreshStatusPills();
    var el = $('audit-log');
    el.innerHTML = '<p class="muted">Loading audit log.</p>';
    try {
      var data = await api('/api/audit');
      var items = asArray(data.audit || data.entries || data);
      if (!items.length) {
        el.innerHTML = '<div class="empty">No data yet. No audit entries recorded.</div>';
        return;
      }
      el.innerHTML = '<table class="log"><thead><tr><th>When</th><th>Action</th><th>Detail</th></tr></thead><tbody>' +
        items.slice(0, 100).map(function (x) {
          return '<tr><td>' + esc(x.created_at || x.createdAt || x.time || x.date || '') + '</td>' +
            '<td>' + esc(x.action || x.type || x.event || '') + '</td>' +
            '<td>' + esc(x.detail || x.description || x.target || '') + '</td></tr>';
        }).join('') + '</tbody></table>';
    } catch (e) {
      el.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    }
  }
  $('btn-refresh-audit').addEventListener('click', loadSettings);

  boot();
})();
