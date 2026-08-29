/* =============================================================
   Epistemia AI — script.js
   All API calls go through POST /api/chat (Vercel serverless).
   No credentials or direct third-party API calls here.
   ============================================================= */

const STORAGE_KEY = 'evidenceDesk.chats.v2';
const $ = id => document.getElementById(id);

const esc = v =>
  String(v ?? '').replace(/[&<>'"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);

/* ── State ── */
let chats    = readChats();
let activeId = chats[0]?.id || null;
let busy     = false;

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
          Interpreting the topic before searching scholarly sources.
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
  setTimeout(() => $('feed').lastElementChild?.scrollIntoView({ block: 'end' }), 0);
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
    .filter(m => m.role !== 'typing')
    .slice(-6)
    .map(m => ({ role: m.role, content: m.content }));
}

/* ── Main send function — proxies through /api/chat ── */
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
  $('sendButton').disabled = true;
  $('prompt').disabled     = true;
  renderAll();

  $('feed').insertAdjacentHTML('beforeend', messageHtml({ role: 'typing' }));

  try {
    const res = await fetch('/api/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ question, history: buildHistory() }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server returned HTTP ${res.status}.`);
    }

    const data = await res.json();

    // Update typing indicator with live search focus if server provided it
    const stage = $('researchStage');
    if (stage && data.searchQuery) {
      stage.innerHTML =
        `<span class="interpretation">Focus: ${esc(data.searchQuery)}</span> · ` +
        (data.specificity === 'specific'
          ? 'narrowing to the strongest matching papers'
          : 'searching broadly across related papers') + '.';
    }

    chat.messages.push({
      role:        'assistant',
      content:     data.answer,
      status:      data.status,
      agreement:   data.agreement,
      limitations: data.limitations,
      sources:     data.sources     || [],
      searchQuery: data.searchQuery || '',
    });

    save();
    renderAll();
  } catch (error) {
    $('typing')?.remove();
    addError(error.message);
  } finally {
    busy                     = false;
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
