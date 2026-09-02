const STORAGE_KEY = 'evidenceDesk.chats.v2';
const $ = id => document.getElementById(id);

const esc = v =>
  String(v ?? '').replace(/[&<>'"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);

/* ── State ── */
let chats    = readChats();
let activeId = chats[0]?.id || null;
let busy     = false;
let pinPrompt = false;   

/* ── Persistence ── */
function uid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `chat-${Date.now()}-${Math.random()}`;
}
function readChats() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
}
function active() {
  return chats.find(c => c.id === activeId);
}

/* ── Toast ── */
function toast(text) {
  const n = $('toast');
  n.textContent = text;
  n.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => n.classList.remove('show'), 2400);
}

/* ── Chat management ── */
function createChat() {
  const chat = { id: uid(), title: 'New research chat', createdAt: Date.now(), messages: [] };
  chats.unshift(chat);
  activeId = chat.id;
  save();
  renderAll();
  $('prompt').focus();
}

function deleteChat(event, chatId) {
  event.stopPropagation();
  const chat = chats.find(c => c.id === chatId);
  if (!chat) return;
  const confirmed = window.confirm(
    `Delete "${chat.title}"? This conversation and its messages will be removed from this browser.`
  );
  if (!confirmed) return;
  chats = chats.filter(c => c.id !== chatId);
  if (activeId === chatId) activeId = chats[0]?.id || null;
  if (!activeId) createChat();
  else { save(); renderAll(); toast('Conversation deleted.'); }
}

function renameChat(event, chatId) {
  event.stopPropagation();
  const chat = chats.find(c => c.id === chatId);
  if (!chat) return;
  const next = window.prompt('Rename conversation', chat.title);
  if (next === null) return;
  const title = next.trim();
  if (!title) { toast('Enter a name for this conversation.'); return; }
  chat.title = title.slice(0, 80);
  save();
  renderAll();
  toast('Conversation renamed.');
}

/* ── Render: sidebar chat list ── */
function renderChats() {
  const list = $('chatList');
  list.innerHTML = chats.map(c => `
    <div class="chat-item ${c.id === activeId ? 'active' : ''}"
         data-chat="${c.id}" role="button" tabindex="0" title="${esc(c.title)}">
      <span class="chat-title">${esc(c.title)}</span>
      <span class="chat-actions">
        <button type="button" class="chat-rename" data-rename="${c.id}"
                title="Rename chat" aria-label="Rename chat">✎</button>
        <button type="button" class="chat-delete" data-delete="${c.id}"
                title="Delete chat" aria-label="Delete chat">×</button>
      </span>
    </div>`).join('');

  list.querySelectorAll('[data-chat]').forEach(b => {
    b.onclick    = () => { activeId = b.dataset.chat; renderAll(); };
    b.onkeydown  = e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activeId = b.dataset.chat; renderAll(); }
    };
  });
  list.querySelectorAll('[data-rename]').forEach(b => b.onclick = e => renameChat(e, b.dataset.rename));
  list.querySelectorAll('[data-delete]').forEach(b => b.onclick = e => deleteChat(e, b.dataset.delete));
}

/* ── Render: welcome screen ── */
function welcome() {
  return `<section class="welcome">
    <div class="spark">✦</div>
    <h1>Think with research.<br><em>Stay close to the source.</em></h1>
    <p>Epistemia AI is a concise research companion. Ask naturally: it finds relevant
       scholarly papers first, then replies from those records with visible citations.</p>
    <div class="prompt-chips" id="promptChips">
      <button>Does remote work improve employee productivity?</button>
      <button>What is the evidence for intermittent fasting and long-term weight loss?</button>
      <button>How does sleep duration affect academic performance?</button>
    </div>
  </section>`;
}

/* ── Render: individual message HTML ── */
function messageHtml(m) {
  if (m.role === 'priorwork') return priorWorkHtml(m);

  if (m.role === 'user') {
    return `<article class="message user">
      <div class="avatar">You</div>
      <div class="bubble">${esc(m.content)}</div>
    </article>`;
  }

  if (m.role === 'typing') {
    return `<article class="message assistant" id="typing">
      <div class="avatar">EA</div>
      <div class="bubble">
        <div class="message-title">Understanding your question</div>
        <div class="typing"><i></i><i></i><i></i></div>
        <div class="status-row" id="researchStage">
          Reading your question closely and mapping out what evidence it needs.
        </div>
      </div>
    </article>`;
  }

  const ans = esc(m.content)
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>')
    .replace(/\[P(\d+)\]/g, "<span class='citation'>[P$1]</span>");

  const focus = m.searchQuery
    ? `<div class="query-focus"><b>Search focus:</b>${esc(m.searchQuery)}</div>`
    : '';

  return `<article class="message assistant">
    <div class="avatar">EA</div>
    <div class="bubble">
      <div class="message-title">Epistemia's research note</div>
      <span class="status-chip ${esc(m.status)}">${esc(m.status)}</span>
      ${focus}
      <div style="margin-top:10px">${ans}</div>
      <div class="limits">
        <b>Agreement signal</b><br>${esc(m.agreement)}<br><br>
        <b>Evidence limitations</b>
        <ul>${m.limitations.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>
      <div class="status-row">
        Based on ${m.sources.length} retrieved papers.
        Open a source in the reading list to inspect the scholarly record.
      </div>
    </div>
  </article>`;
}

/* ── Render: main feed ── */
function renderFeed() {
  const chat = active();
  $('chatName').textContent = `› ${chat?.title || 'New chat'}`;
  $('feed').innerHTML = !chat?.messages.length
    ? welcome()
    : chat.messages.map(messageHtml).join('');
  $('promptChips')?.querySelectorAll('button').forEach(b => b.onclick = () => send(b.textContent));
  if (pinPrompt) setTimeout(() => scrollToLatestPrompt('auto'), 0);
  else setTimeout(() => $('feed').lastElementChild?.scrollIntoView({ block: 'end' }), 0);
}

/* ── Scroll: jump to the newest prompt (works for desktop feed + mobile page scroll) ── */
function feedScroller() {
  const feed = $('feed');
  const oy   = getComputedStyle(feed).overflowY;
  const scrollable = (oy === 'auto' || oy === 'scroll') && feed.scrollHeight > feed.clientHeight + 2;
  return scrollable ? feed : null;
}

function setFeedTailSpace(px) {
  const feed = $('feed');
  feed.style.setProperty('--tail-space', px > 0 ? `${Math.ceil(px)}px` : '0px');
}

function scrollToLatestPrompt(behavior = 'smooth') {
  const nodes = $('feed').querySelectorAll('.message.user');
  const el    = nodes[nodes.length - 1];
  if (!el) return;

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const gap       = 12;
    const container = feedScroller() || document.scrollingElement || document.documentElement;
    const usesFeed  = container === $('feed');
    const bar       = document.querySelector('.mbar');
    const barH      = !usesFeed && bar && getComputedStyle(bar).display !== 'none' ? bar.offsetHeight : 0;
    const anchorTop = usesFeed ? container.getBoundingClientRect().top : 0;

    const target = container.scrollTop + el.getBoundingClientRect().top - anchorTop - barH - gap;
    const max    = container.scrollHeight - container.clientHeight;

    // Add just enough tail space so the newest prompt can actually reach the top.
    if (target > max) {
      setFeedTailSpace(target - max);
      requestAnimationFrame(() => {
        const m = container.scrollHeight - container.clientHeight;
        container.scrollTo({ top: Math.max(0, Math.min(target, m)), behavior });
      });
      return;
    }
    container.scrollTo({ top: Math.max(0, target), behavior });
  }));
}

/* ── Render: sources panel ── */
function latestSources() {
  const messages = active()?.messages || [];
  return [...messages].reverse().find(m => m.sources)?.sources || [];
}

function renderSources() {
  const papers = latestSources();
  const list   = $('sourceList');
  $('sourceCount').textContent = papers.length;

  if (!papers.length) {
    list.className   = 'source-empty';
    list.textContent = 'The latest response\'s related research papers will appear here. Click a card to open the paper record in a new tab.';
    return;
  }

  list.className = '';
  list.innerHTML  = papers.map((p, i) => `
    <a class="source-card" href="${esc(p.url)}" target="_blank" rel="noopener">
      <span class="source-tag">P${i + 1}</span>
      <h3>${esc(p.title)}</h3>
      <div class="source-meta">
        ${esc(p.authors)} · ${esc(p.date || p.year || 'Date unavailable')}<br>
        ${esc(p.venue || 'Venue unavailable')}
      </div>
      <div class="source-stats">
        <span>${p.citations.toLocaleString()} citations</span>
        ${p.openAccess ? '<span>Open access</span>' : ''}
      </div>
      <span class="source-link">Open full record ↗</span>
    </a>`).join('');
}

function renderAll() {
  renderChats();
  renderFeed();
  renderSources();
}

/* ── Error display ── */
function addError(message) {
  const n = document.createElement('div');
  n.className = 'error';
  n.innerHTML = `<b>Research request unavailable.</b> ${esc(message)}`;
  $('feed').appendChild(n);
  n.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

/* ── Build conversation history for the API ── */
function buildHistory() {
  return (active()?.messages || [])
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map(m => ({ role: m.role, content: m.content }));
}

/* ── Main send function — streams progress from /api/chat ── */
async function send(value) {
  const question = value.trim();
  if (busy) return;
  if (question.length < 3) { toast('Enter a research question with at least three characters.'); return; }
  if (!activeId) createChat();

  const chat = active();
  chat.messages.push({ role: 'user', content: question });
  if (chat.title === 'New research chat')
    chat.title = question.slice(0, 38) + (question.length > 38 ? '…' : '');
  save();

  $('prompt').value        = '';
  $('prompt').style.height = 'auto';
  busy                     = true;
  pinPrompt                = true;
  $('sendButton').disabled = true;
  $('prompt').disabled     = true;
  renderAll();

  // Insert the typing bubble immediately so the user sees activity
  $('feed').insertAdjacentHTML('beforeend', messageHtml({ role: 'typing' }));
  scrollToLatestPrompt();

 
  const MIN_STAGE_MS = {
    planning:    2000,
    interpreted: 3600,
    refined:     3400,
    searching:   2400,
    reading:     2800,
    result:         0,
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let stageChain = Promise.resolve();

  const stage = (key, render) => {
    stageChain = stageChain.then(async () => {
      try { render(); } catch { /* stage rendering is best-effort */ }
      const wait = MIN_STAGE_MS[key] ?? 1500;
      if (wait) await sleep(wait);
    });
    return stageChain;
  };
  const setStage = (key, html) =>
    stage(key, () => { const el = $('researchStage'); if (el) el.innerHTML = html; });
  const setTitle = text =>
    { const el = document.querySelector('#typing .message-title'); if (el) el.textContent = text; };

  try {
    const res = await fetch('/api/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ question, history: buildHistory() }),
    });

    if (!res.ok) {
      // Non-2xx before streaming started (e.g. 400, 500)
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server returned HTTP ${res.status}.`);
    }

    // Read the NDJSON stream line-by-line
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;

      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep any incomplete trailing line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let evt;
        try { evt = JSON.parse(trimmed); } catch { continue; }

        /* ── Stage 0: server started planning ── */
        if (evt.event === 'planning') {
          setStage('planning',
            'Reading your question closely and mapping out what evidence it needs.');
        }

        /* ── Stage 1: first interpretation → show the focus point ── */
        if (evt.event === 'interpreted') {
          setStage('interpreted',
            `<span class="interpretation">Focus: ${esc(evt.searchQuery)}</span> · ` +
            (evt.specificity === 'specific'
              ? 'reading this as a specific question with linked constraints'
              : 'reading this as a broad topic overview') + '.');
        }

        /* ── Stage 1b: plan reviewed and sharpened ── */
        if (evt.event === 'refined') {
          setStage('refined',
            `<span class="interpretation">Refined focus: ${esc(evt.searchQuery)}</span> · ` +
            (evt.rationale ? esc(evt.rationale) + ' ' : '') +
            'Now searching the scholarly index.');
        }

        /* ── Stage 2: papers retrieved ── */
        if (evt.event === 'searching') {
          setStage('searching',
            `Searched the full scholarly index and selected ${evt.count} ` +
            `${evt.count === 1 ? 'paper' : 'papers'} for close reading.`);
        }

        /* ── Stage 2b: reading the retrieved evidence ── */
        if (evt.event === 'reading') {
          stage('reading', () => {
            setTitle('Reading the evidence');
            const el = $('researchStage');
            if (el) el.textContent =
              `Reading ${evt.count} ${evt.count === 1 ? 'abstract' : 'abstracts'}, ` +
              'weighing agreement and disagreement before answering.';
          });
        }

        /* ── Stage 3: final answer (held until earlier stages have shown) ── */
        if (evt.event === 'result') {
          stage('result', () => {
            chat.messages.push({
              role:        'assistant',
              content:     evt.answer,
              status:      evt.status,
              agreement:   evt.agreement,
              limitations: evt.limitations,
              sources:     evt.sources     || [],
              searchQuery: evt.searchQuery || '',
            });
            save();
            renderAll();
          });
        }

        /* ── Server-side error event ── */
        if (evt.event === 'error') {
          throw new Error(evt.error || 'An unexpected server error occurred.');
        }
      }
    }

    // Let every queued stage (including the final answer) finish rendering
    await stageChain;

  } catch (error) {
    try { await stageChain; } catch { /* ignore stage errors */ }
    $('typing')?.remove();
    addError(error.message);
  } finally {
    busy                     = false;
    pinPrompt                = false;
  setFeedTailSpace(0);
    $('sendButton').disabled = false;
    $('prompt').disabled     = false;
    $('prompt').focus();
  }
}

/* ── Initialise ── */
$('newChat').onclick    = createChat;
$('chatForm').onsubmit  = e => { e.preventDefault(); send($('prompt').value); };
$('prompt').onkeydown   = e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('prompt').value); }
};
$('prompt').oninput = () => {
  const p = $('prompt');
  p.style.height = 'auto';
  p.style.height = `${Math.min(p.scrollHeight, 140)}px`;
};

if (!activeId) createChat();
else renderAll();

/* ── Mobile navigation layer ── */
(function () {
  const body  = document.body;
  const scrim = $('scrim');
  const isMobile = () => window.matchMedia('(max-width:900px)').matches;

  function closeAll() { body.classList.remove('nav-open', 'src-open'); }
  function toggle(cls) { const on = body.classList.contains(cls); closeAll(); if (!on) body.classList.add(cls); }

  $('navToggle').onclick = () => toggle('nav-open');
  $('srcToggle').onclick = () => toggle('src-open');
  $('newChatM').onclick  = () => { createChat(); closeAll(); };

  const sc = $('srcClose');
  if (sc) {
    sc.onclick = closeAll;
    const showClose = () => { sc.style.display = isMobile() ? 'grid' : 'none'; };
    showClose();
    window.addEventListener('resize', showClose);
  }

  scrim.onclick = closeAll;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });
  $('chatList').addEventListener('click', e => { if (!e.target.closest('[data-rename],[data-delete]')) closeAll(); });
  window.addEventListener('resize', () => { if (!isMobile()) closeAll(); });

  /* Sync mobile header with desktop state */
  function sync() {
    $('mChatName').textContent =
      ($('chatName').textContent || '').replace(/^›\s*/, '') || 'New conversation';
    const n     = Number($('sourceCount').textContent || 0);
    const badge = $('srcBadge');
    badge.textContent = n;
    badge.hidden      = !n;
  }

  const _renderAll    = renderAll;
  renderAll = function () { _renderAll.apply(this, arguments); sync(); };

  const _renderSources = renderSources;
  renderSources = function () { _renderSources.apply(this, arguments); sync(); };

  sync();

  if (isMobile()) $('prompt').placeholder = 'Ask a research question…';

  /* Keep composer above mobile keyboard */
  if (window.visualViewport) {
    const wrap = document.querySelector('.composer-wrap');
    const fit  = () => {
      if (!isMobile()) { wrap.style.transform = ''; return; }
      const vv     = window.visualViewport;
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      wrap.style.transform = offset > 80 ? `translateY(-${offset}px)` : '';
    };
    window.visualViewport.addEventListener('resize', fit);
    window.visualViewport.addEventListener('scroll', fit);
  }

  $('prompt').addEventListener('focus', () => {
    if (isMobile()) setTimeout(() => $('prompt').scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
  });
})();


/* ═══════════════════════════════════════════════════════════════
   Prior Work & Semantic Match Assistant
   Pipeline: draft → optimised query → OpenAlex → overlap report
   ═══════════════════════════════════════════════════════════════ */

const PW_DISCLAIMER =
  'This analysis is based on available titles, abstracts, and metadata indexed in OpenAlex ' +
  '(250M+ records). It does not scan full paywalled paper bodies.';

const PW_STATUS_LABEL = {
  HIGH_OVERLAP:    'High overlap',
  MEDIUM_OVERLAP:  'Medium overlap',
  LOW_OVERLAP:     'Low overlap',
  NO_MATCHES_FOUND:'No matches found',
};

function pwLevelClass(level) {
  const v = String(level || '').toLowerCase();
  return v.startsWith('high') ? 'high' : v.startsWith('med') ? 'medium' : 'low';
}

/* ── Render: prior-work report message ── */
function priorWorkHtml(m) {
  const r = m.report || {};
  const papers = Array.isArray(r.matched_papers) ? r.matched_papers : [];
  const statusKey = String(r.match_status || 'LOW_OVERLAP').toUpperCase();

  const cards = papers.length ? papers.map((p, i) => `
    <div class="pw-card">
      <div class="pw-card-head">
        <span class="source-tag">P${i + 1}</span>
        <span class="pw-level ${pwLevelClass(p.similarity_level)}">${esc(p.similarity_level || 'Low')} similarity</span>
      </div>
      <h4>${esc(p.title || 'Untitled record')}</h4>
      <div class="source-meta">
        ${esc(p.authors || 'Authors unavailable')} · ${esc(p.publication_year || 'Year unavailable')}
      </div>
      ${(p.overlapping_concepts || []).length
        ? `<ul class="pw-concepts">${p.overlapping_concepts.map(c => `<li>${esc(c)}</li>`).join('')}</ul>`
        : ''}
      ${p.url ? `<a class="source-link" href="${esc(p.url)}" target="_blank" rel="noopener">Open OpenAlex record ↗</a>` : ''}
    </div>`).join('')
    : `<div class="status-row">No sufficiently related records were returned by OpenAlex for this draft.</div>`;

  return `<article class="message assistant">
    <div class="avatar">EA</div>
    <div class="bubble">
      <div class="message-title">Prior work &amp; semantic match report</div>
      <span class="status-chip pw-status ${pwLevelClass(statusKey.split('_')[0])}">${esc(PW_STATUS_LABEL[statusKey] || statusKey)}</span>
      ${m.paperTitle ? `<div class="query-focus"><b>Draft:</b>${esc(m.paperTitle)}</div>` : ''}
      <div class="query-focus"><b>Search focus:</b>${esc(r.search_query || '')}</div>
      <div style="margin-top:10px">${esc(r.summary || '')}</div>
      <div class="pw-cards">${cards}</div>
      <div class="limits"><b>Scope of this check</b><br>${esc(r.disclaimer || PW_DISCLAIMER)}</div>
    </div>
  </article>`;
}

/* ── Modal plumbing ── */
(function () {
  const modal  = $('pwModal');
  const scrim  = $('pwScrim');
  const status = $('pwStatus');
  let running  = false;

  function open() {
    modal.hidden = false; scrim.hidden = false;
    document.body.classList.remove('nav-open', 'src-open');
    status.textContent = '';
    setTimeout(() => $('pwPaperTitle').focus(), 30);
  }
  function close() {
    if (running) return;
    modal.hidden = true; scrim.hidden = true;
  }

  $('priorWorkBtn').onclick = open;
  $('priorWorkM').onclick   = open;
  $('pwClose').onclick      = close;
  $('pwCancel').onclick     = close;
  scrim.onclick             = close;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) close(); });

  $('pwRun').onclick = async () => {
    if (running) return;
    const title = $('pwPaperTitle').value.trim();
    const text  = $('pwPaperText').value.trim();

    if (title.length < 3)  { toast('Add the title of your draft.'); return; }
    if (text.length  < 80) { toast('Paste at least a paragraph of your draft (80+ characters).'); return; }

    running = true;
    $('pwRun').disabled = true;
    status.textContent = 'Condensing your draft into an OpenAlex query…';

    try {
      const res = await fetch('/api/prior-work', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ title, text }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server returned HTTP ${res.status}.`);
      if (!data.match_status) throw new Error('The analysis service returned an unexpected response.');

      if (!activeId) createChat();
      const chat = active();
      chat.messages.push({
        role:       'priorwork',
        content:    `Prior work check — ${title}`,
        paperTitle: title,
        report:     data,
        sources:    (data.matched_papers || []).map(p => ({
          title:      p.title || 'Untitled record',
          authors:    p.authors || 'Authors unavailable',
          year:       p.publication_year || '',
          venue:      p.venue || 'OpenAlex record',
          url:        p.url || p.openalex_id || '#',
          citations:  Number(p.citations || 0),
          openAccess: !!p.open_access,
        })),
      });
      if (chat.title === 'New research chat') chat.title = `Prior work · ${title}`.slice(0, 48);
      save();

      modal.hidden = true; scrim.hidden = true;
      renderAll();
      toast('Prior work analysis added to this conversation.');
    } catch (err) {
      status.textContent = '';
      toast(err.message || 'Prior work analysis failed.');
    } finally {
      running = false;
      $('pwRun').disabled = false;
    }
  };
})();
