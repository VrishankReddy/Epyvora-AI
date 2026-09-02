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
let detectorOpen = false;
let detectorBusy = false;
let detectorFile = null;
let detectorResult = null;

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
  renderDetector();
}

/* ── Plagiarism detector ── */
function openDetector() {
  detectorOpen = true;
  detectorResult = null;
  detectorFile = null;
  renderAll();
  setTimeout(() => $('detectorTopic')?.focus(), 0);
}

function closeDetector() {
  detectorOpen = false;
  detectorBusy = false;
  detectorFile = null;
  detectorResult = null;
  renderAll();
}

function detectorShell(content) {
  return `<section class="detector">
    <div class="detector-head">
      <div>
        <div class="eyebrow">Epistemia integrity tools</div>
        <h1>Plagiarism detector</h1>
        <p>Screen a paper or excerpt against scholarly records and see the passages that deserve a closer look.</p>
      </div>
      <button class="detector-back" id="detectorBack" type="button">← Back to research</button>
    </div>
    ${content}
  </section>`;
}

function detectorFormHtml() {
  return `<form class="detector-form" id="detectorForm">
    <div class="detector-grid">
      <label class="detector-field">
        <span>Topic, title, or theme <b>required</b></span>
        <input id="detectorTopic" name="topic" type="text"
               placeholder="e.g. How remote work affects productivity" maxlength="180" required>
        <small>Used to find the most relevant scholarly records.</small>
      </label>
      <div class="detector-field">
        <span>Upload a paper or excerpt <b>optional</b></span>
        <label class="upload-box" for="detectorFile">
          <span class="upload-mark">↑</span>
          <span><strong id="fileName">Choose a file</strong><small>TXT, MD, PDF, DOCX · up to 20 MB</small></span>
        </label>
        <input id="detectorFile" name="file" type="file"
               accept=".txt,.md,.csv,.json,.html,.pdf,.doc,.docx,text/plain,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document">
      </div>
    </div>

    <label class="detector-field">
      <span>Paste the text to screen <b>recommended</b></span>
      <textarea id="detectorText" name="text" rows="10"
        placeholder="Paste the abstract, paragraph, or any chunk you want Epistemia to compare…"></textarea>
      <small id="detectorCount">0 words · For PDF/DOCX uploads, paste text here for the browser fallback, or use the live server endpoint.</small>
    </label>

    <div class="detector-actions">
      <button class="detector-submit" id="detectorSubmit" type="submit">
        <span>✦</span> Run plagiarism screen
      </button>
      <span class="detector-privacy">Your text is used for this check and is not saved to the conversation history.</span>
    </div>
  </form>`;
}

function renderDetector() {
  const view = $('detectorView');
  const feed = $('feed');
  const composer = document.querySelector('.composer-wrap');
  if (!view) return;

  view.hidden = !detectorOpen;
  feed.hidden = detectorOpen;
  if (composer) composer.hidden = detectorOpen;
  if (!detectorOpen) { view.innerHTML = ''; return; }

  if (detectorBusy) {
    view.innerHTML = detectorShell(`<div class="detector-loading">
      <div class="detector-spinner"></div>
      <h2>Comparing your text with scholarly records</h2>
      <p>Epistemia is looking for meaningful phrase overlap, not just matching topic words.</p>
      <div class="loading-track"><i></i></div>
    </div>`);
    $('detectorBack').onclick = closeDetector;
    return;
  }

  if (detectorResult) {
    view.innerHTML = detectorShell(detectorResultHtml(detectorResult));
    $('detectorBack').onclick = closeDetector;
    $('runAnother').onclick = () => {
      detectorResult = null;
      renderDetector();
      setTimeout(() => $('detectorTopic')?.focus(), 0);
    };
    return;
  }

  view.innerHTML = detectorShell(detectorFormHtml());
  $('detectorBack').onclick = closeDetector;
  const fileInput = $('detectorFile');
  const textInput = $('detectorText');
  const updateCount = () => {
    const count = (textInput.value.trim().match(/\S+/g) || []).length;
    $('detectorCount').textContent =
      `${count.toLocaleString()} words · ${count < 40 ? 'Add more text for a stronger comparison.' : 'Longer excerpts produce a more useful signal.'}`;
  };
  textInput.oninput = updateCount;
  fileInput.onchange = async () => {
    detectorFile = fileInput.files?.[0] || null;
    $('fileName').textContent = detectorFile?.name || 'Choose a file';
    if (!detectorFile) return;
    if (isBrowserReadable(detectorFile)) {
      try {
        textInput.value = await detectorFile.text();
        updateCount();
        toast('Text extracted from the file.');
      } catch { toast('Could not read that file in the browser.'); }
    } else {
      $('detectorCount').textContent =
        `${formatBytes(detectorFile.size)} attached · PDF/DOCX extraction will use the live server endpoint.`;
    }
  };
  $('detectorForm').onsubmit = e => { e.preventDefault(); runPlagiarismCheck(); };
}

function isBrowserReadable(file) {
  return file.type.startsWith('text/') || /\.(txt|md|csv|json|html?)$/i.test(file.name);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function wordCount(text) {
  return (String(text || '').trim().match(/\S+/g) || []).length;
}

function normalizeWords(text) {
  return String(text || '').toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/).filter(Boolean);
}

function abstractFromOpenAlex(work) {
  const index = work?.abstract_inverted_index;
  if (!index) return '';
  const words = [];
  Object.entries(index).forEach(([word, positions]) => {
    positions.forEach(position => { words[position] = word; });
  });
  return words.filter(Boolean).join(' ');
}

function sourceFromOpenAlex(work) {
  const authors = (work.authorships || []).slice(0, 3)
    .map(a => a.author?.display_name).filter(Boolean).join(', ');
  const landing = work.primary_location?.landing_page_url ||
    work.doi || `https://openalex.org/${work.id?.split('/').pop() || ''}`;
  return {
    title: work.title || 'Untitled scholarly work',
    authors: authors || 'Authors unavailable',
    year: work.publication_year || 'Year unavailable',
    venue: work.primary_location?.source?.display_name || 'Scholarly record',
    url: landing,
    citations: work.cited_by_count || 0,
    openAccess: Boolean(work.open_access?.is_oa),
    abstract: abstractFromOpenAlex(work),
  };
}

function makePhrases(words, size = 8) {
  const phrases = [];
  for (let i = 0; i <= words.length - size; i += 1) {
    const phrase = words.slice(i, i + size).join(' ');
    if (phrase.length > 34) phrases.push({ phrase, start: i });
  }
  return phrases;
}

function compareAgainstSource(text, source) {
  const sourceWords = normalizeWords(source.abstract);
  const inputWords = normalizeWords(text);
  if (sourceWords.length < 12 || inputWords.length < 12) return { matches: [], similarity: 0 };
  const sourceText = sourceWords.join(' ');
  const matches = makePhrases(inputWords).filter(item =>
    sourceText.includes(item.phrase)
  ).slice(0, 4);
  const sourceSet = new Set(sourceWords);
  const shared = inputWords.filter(w => w.length > 4 && sourceSet.has(w)).length;
  const similarity = Math.min(99, Math.round(
    matches.length * 7 + (shared / Math.max(1, inputWords.length)) * 28
  ));
  return { matches, similarity };
}

async function searchOpenAlex(topic, text) {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(topic)}&filter=has_abstract:true&per-page=8`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`OpenAlex returned HTTP ${response.status}`);
  const data = await response.json();
  const ranked = (data.results || []).map(work => {
    const source = sourceFromOpenAlex(work);
    const comparison = compareAgainstSource(text, source);
    return { ...source, ...comparison };
  }).filter(source => source.similarity > 0).sort((a, b) => b.similarity - a.similarity);
  return ranked;
}

function fallbackSources(topic) {
  const t = topic.toLowerCase();
  if (/remote|work.?from.?home|telework|productiv/.test(t)) {
    return [{
      title: 'Does Working from Home Work? Evidence from a Chinese Experiment',
      authors: 'Nicholas Bloom, James Liang, John Roberts, Zhichun Jenny Ying',
      year: 2015, venue: 'The Quarterly Journal of Economics',
      url: 'https://doi.org/10.1093/qje/qju032', citations: 0, openAccess: false,
      abstract: ''
    }];
  }
  if (/sleep|academic|student|learning/.test(t)) {
    return [{
      title: 'Sleep loss, learning capacity and academic performance',
      authors: 'Giuseppe Curcio, Michele Ferrara, Luigi De Gennaro',
      year: 2006, venue: 'Sleep Medicine Reviews',
      url: 'https://doi.org/10.1016/j.smrv.2005.11.001', citations: 0, openAccess: false,
      abstract: ''
    }];
  }
  return [];
}

function localScreen(topic, text, file) {
  const sources = fallbackSources(topic);
  const hasText = wordCount(text) > 0;
  return {
    score: hasText ? 0 : null,
    verdict: hasText ? 'No confirmed overlap in the local fallback' : 'Text needed for browser screening',
    confidence: 'Low',
    sources,
    matches: [],
    method: 'Browser fallback',
    note: file && !hasText
      ? 'This file type needs the live /api/plagiarism endpoint for text extraction. The attached file was preserved for that request.'
      : 'The live scholarly screen was unavailable, so no plagiarism conclusion can be made from this fallback.',
  };
}

function normalizeServerResult(result) {
  const sources = (result.sources || result.matches || []).map(source => ({
    ...source,
    url: source.url || source.doi || '#',
    authors: Array.isArray(source.authors) ? source.authors.join(', ') : (source.authors || 'Authors unavailable'),
    citations: Number(source.citations || source.cited_by_count || 0),
    year: source.year || source.publication_year || 'Year unavailable',
  }));
  return {
    score: result.score ?? result.similarity ?? 0,
    verdict: result.verdict || (result.score > 20 ? 'Potential overlap found' : 'No substantial overlap found'),
    confidence: result.confidence || 'Medium',
    sources,
    matches: result.matchedPassages || result.matches || [],
    method: result.method || 'Epistemia scholarly screening',
    note: result.note || 'Similarity is a signal for review, not a final plagiarism determination.',
  };
}

function escapeHighlight(text) {
  return esc(text).replace(/\*\*(.*?)\*\*/g, '<mark>$1</mark>');
}

function detectorResultHtml(result) {
  const score = result.score == null ? '—' : `${Math.round(result.score)}%`;
  const scoreClass = result.score == null ? 'unknown' : result.score >= 50 ? 'high' : result.score >= 20 ? 'medium' : 'low';
  const sourceHtml = result.sources.length
    ? result.sources.slice(0, 5).map((source, index) => `
      <a class="detector-source" href="${esc(source.url)}" target="_blank" rel="noopener">
        <span class="source-tag">P${index + 1}</span>
        <div><h3>${esc(source.title)}</h3>
        <p>${esc(source.authors)} · ${esc(source.year)} · ${esc(source.venue)}</p>
        <span>Open scholarly record ↗</span></div>
      </a>`).join('')
    : `<div class="detector-empty">No source record crossed the overlap threshold. That does not prove the text is original; try a longer excerpt or connect the live server checker.</div>`;
  const matchHtml = result.matches?.length
    ? `<div class="matches"><h3>Passages to review</h3>${result.matches.slice(0, 5).map(match => {
        const phrase = typeof match === 'string' ? match : match.phrase || match.text || '';
        return `<blockquote>“${escapeHighlight(phrase)}”</blockquote>`;
      }).join('')}</div>`
    : '';
  return `<div class="detector-result">
    <div class="result-top">
      <div class="score-card ${scoreClass}">
        <span class="score-label">Overlap signal</span><strong>${score}</strong>
        <span>${esc(result.confidence)} confidence</span>
      </div>
      <div class="result-summary">
        <span class="result-kicker">${esc(result.method)}</span>
        <h2>${esc(result.verdict)}</h2>
        <p>${esc(result.note)}</p>
      </div>
    </div>
    <div class="result-columns">
      <div><div class="result-section-head"><span class="eyebrow">Likely source papers</span><span class="source-count">${result.sources.length}</span></div>
        <div class="detector-sources">${sourceHtml}</div></div>
      ${matchHtml}
    </div>
    <div class="detector-disclaimer"><b>Use this as a lead, not a verdict.</b> Similar wording can be legitimate quotation, common terminology, or independently written. Verify the original paper, citation context, and your institution’s policy before taking action.</div>
    <button class="run-another" id="runAnother" type="button">Run another screen</button>
  </div>`;
}

async function runPlagiarismCheck() {
  if (detectorBusy) return;
  const topic = $('detectorTopic')?.value.trim() || '';
  const text = $('detectorText')?.value.trim() || '';
  const file = detectorFile || $('detectorFile')?.files?.[0] || null;
  if (topic.length < 3) { toast('Add a topic, title, or theme first.'); return; }
  if (!text && !file) { toast('Paste text or attach a paper to screen.'); return; }
  if (file && file.size > 20 * 1024 * 1024) { toast('Please keep uploads under 20 MB.'); return; }

  detectorBusy = true;
  renderDetector();
  try {
    const form = new FormData();
    form.append('topic', topic);
    form.append('text', text);
    if (file) form.append('file', file, file.name);
    const response = await Promise.race([
      fetch('/api/plagiarism', { method: 'POST', body: form }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('server timeout')), 12000))
    ]);
    if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
    const payload = await response.json();
    detectorResult = normalizeServerResult(payload.result || payload);
  } catch {
    try {
      if (!text) throw new Error('Text extraction requires the server checker');
      const sources = await searchOpenAlex(topic, text);
      const best = sources[0];
      detectorResult = {
        score: best?.similarity || 0,
        verdict: best?.similarity >= 20 ? 'Potential overlap found' : 'No substantial overlap found',
        confidence: best ? (best.similarity >= 45 ? 'Medium' : 'Low') : 'Low',
        sources,
        matches: best?.matches?.map(m => m.phrase) || [],
        method: 'OpenAlex abstract screening',
        note: best
          ? 'A phrase-level match was found in the abstracts available through OpenAlex. Full-text comparison needs the live server checker.'
          : 'No meaningful phrase overlap was found in the small abstract set returned for this topic.',
      };
    } catch {
      detectorResult = localScreen(topic, text, file);
    }
  } finally {
    detectorBusy = false;
    renderDetector();
  }
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
$('plagiarismButton').onclick = openDetector;
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
