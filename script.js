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

/* ── Research Galaxy state ── */
let galaxyData = { nodes: [], links: [] };
let galaxyFilter = null;
let galaxySelectedId = null;
let galaxySimulation = null;
let galaxyZoom = null;
let galaxyZoomGroup = null;
let galaxySvg = null;

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

/* ── Research Galaxy extraction ── */
const GALAXY_COLORS = {
  concept: '#8b5bb1',
  paper: '#4c8ec8',
  method: '#5eaa78',
  critique: '#d47a42',
};

function galaxyNodeId(type, label) {
  return `${type}:${String(label).toLowerCase().trim()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
}

function paperNodeLabel(index, paper) {
  const authors = String(paper?.authors || '').split(/[;,]/)[0].trim();
  const year = paper?.year || paper?.date || '';
  const title = String(paper?.title || '').trim();
  const shortTitle = title.length > 42 ? `${title.slice(0, 42).trim()}…` : title;
  const descriptor = authors && year ? `${authors} ${year}` : (shortTitle || `Paper ${index + 1}`);
  return `[P${index + 1}] ${descriptor}`;
}

function getOrCreateGalaxyNode(map, type, label, meta = {}) {
  const cleanLabel = String(label || '').replace(/\s+/g, ' ').trim();
  if (!cleanLabel) return null;
  const id = galaxyNodeId(type, cleanLabel);
  if (!map.has(id)) {
    map.set(id, { id, label: cleanLabel, type, count: 1, ...meta });
  } else {
    map.get(id).count += 1;
  }
  return map.get(id);
}

function addGalaxyLink(links, source, target, relation) {
  if (!source || !target || source.id === target.id) return;
  const key = `${source.id}|${target.id}|${relation}`;
  if (!links.some(link => link._key === key)) {
    links.push({ source: source.id, target: target.id, relation, _key: key });
  }
}

function rebuildGalaxyData() {
  const nodeMap = new Map();
  const links = [];
  const messages = active()?.messages || [];
  const methodPattern = /\b(RCT|randomized controlled trial|meta-analysis|systematic review|cohort study|cross-sectional|longitudinal|qualitative|quantitative|case-control)\b/gi;
  const contradictionPattern = /\b(contradict|disagree|conflict|mixed evidence|mixed results|limitation|caveat|inconclusive)\b/i;

  messages.filter(m => m.role === 'assistant' && m.content).forEach((m, messageIndex) => {
    const paperNodes = (m.sources || []).map((paper, i) =>
      getOrCreateGalaxyNode(nodeMap, 'paper', paperNodeLabel(i, paper), {
        title: paper?.title || '',
        authors: paper?.authors || '',
        year: paper?.year || paper?.date || '',
        url: paper?.url || '',
      })
    ).filter(Boolean);

    // Keep cited papers visible even if a server response omitted source metadata.
    const citedIndexes = [...String(m.content).matchAll(/\[P(\d+)\]/gi)]
      .map(match => Number(match[1]) - 1)
      .filter(index => index >= 0);
    citedIndexes.forEach(index => {
      if (!paperNodes[index]) {
        paperNodes[index] = getOrCreateGalaxyNode(nodeMap, 'paper', `[P${index + 1}] Paper ${index + 1}`);
      }
    });

    const conceptNodes = [];
    for (const match of String(m.content).matchAll(/\*\*(.*?)\*\*/g)) {
      const node = getOrCreateGalaxyNode(nodeMap, 'concept', match[1]);
      if (node && !conceptNodes.some(existing => existing.id === node.id)) conceptNodes.push(node);
    }
    const methodNodes = [];
    for (const match of String(m.content).matchAll(methodPattern)) {
      const node = getOrCreateGalaxyNode(nodeMap, 'method', match[1]);
      if (node && !methodNodes.some(existing => existing.id === node.id)) methodNodes.push(node);
    }

    const focus = String(m.searchQuery || '').trim();
    const focusNode = focus ? getOrCreateGalaxyNode(nodeMap, 'concept', focus, { isFocus: true }) : null;
    const relation = (m.status === 'mixed' || contradictionPattern.test(m.content) || contradictionPattern.test(m.agreement || ''))
      ? 'contradicts' : 'supports';

    [...conceptNodes, ...methodNodes, ...(focusNode ? [focusNode] : [])].forEach(node => {
      paperNodes.forEach(paper => addGalaxyLink(links, node, paper, node.type === 'method' ? 'uses' : 'supports'));
    });

    if (paperNodes.length > 1 && relation === 'contradicts') {
      for (let i = 1; i < paperNodes.length; i += 1) {
        addGalaxyLink(links, paperNodes[0], paperNodes[i], 'contradicts');
      }
      const critiqueLabel = m.status === 'mixed' ? 'Mixed evidence' : 'Evidence limitation';
      const critique = getOrCreateGalaxyNode(nodeMap, 'critique', critiqueLabel);
      paperNodes.forEach(paper => addGalaxyLink(links, critique, paper, 'contradicts'));
    }
  });

  galaxyData = {
    nodes: [...nodeMap.values()],
    links: links.map(({ _key, ...link }) => link),
  };
  if (galaxySelectedId && !nodeMap.has(galaxySelectedId)) galaxySelectedId = null;
  if (galaxyFilter && !nodeMap.has(galaxyFilter)) galaxyFilter = null;
}

function paperNodeIdForMessage(m, index) {
  return galaxyNodeId('paper', paperNodeLabel(index, m.sources?.[index]));
}

function decorateAnswer(m) {
  const raw = String(m.content || '');
  const tokenPattern = /\*\*(.*?)\*\*|\[P(\d+)\]/g;
  let html = '';
  let cursor = 0;
  let match;
  const appendText = text => { html += esc(text).replace(/\n/g, '<br>'); };

  while ((match = tokenPattern.exec(raw))) {
    appendText(raw.slice(cursor, match.index));
    if (match[1] !== undefined) {
      const label = match[1].trim();
      const id = galaxyNodeId('concept', label);
      html += `<b class="galaxy-mark" data-galaxy-node="${esc(id)}" tabindex="0">${esc(label)}</b>`;
    } else {
      const index = Number(match[2]) - 1;
      const id = paperNodeIdForMessage(m, index);
      html += `<span class="citation galaxy-mark" data-galaxy-node="${esc(id)}" tabindex="0">[P${esc(match[2])}]</span>`;
    }
    cursor = match.index + match[0].length;
  }
  appendText(raw.slice(cursor));
  return html;
}

function selectedGalaxyNode() {
  return galaxyData.nodes.find(node => node.id === galaxySelectedId) || null;
}

function messageMatchesGalaxyNode(m, node) {
  if (!node) return true;
  const content = `${m.content || ''} ${m.searchQuery || ''} ${m.agreement || ''} ${(m.limitations || []).join(' ')}`.toLowerCase();
  if (node.type === 'paper') {
    const tag = node.label.match(/\[P\d+\]/i)?.[0]?.toLowerCase();
    const paperTitle = node.title?.toLowerCase();
    return Boolean((tag && content.includes(tag)) || (paperTitle && content.includes(paperTitle)));
  }
  if (node.type === 'critique') return m.role === 'assistant' && (m.status === 'mixed' || /limitation|contradict|disagree|caveat|inconclusive/i.test(content));
  return content.includes(node.label.toLowerCase());
}

function graphTypeLabel(type) {
  return ({ concept: 'Concept', paper: 'Paper', method: 'Methodology', critique: 'Critique' })[type] || type;
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

  const ans = decorateAnswer(m);

  const focus = m.searchQuery
    ? `<div class="query-focus"><b>Search focus:</b>${esc(m.searchQuery)}</div>`
    : '';

  return `<article class="message assistant">
    <div class="avatar">EA</div>
    <div class="bubble">
      <div class="message-title">Epistemia's research note</div>
      <span class="status-chip ${esc(m.status || 'evidence')}">${esc(m.status || 'evidence')}</span>
      ${focus}
      <div style="margin-top:10px">${ans}</div>
      <div class="limits">
        <b>Agreement signal</b><br>${esc(m.agreement || 'No agreement signal recorded.')}<br><br>
        <b>Evidence limitations</b>
        <ul>${(m.limitations || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>
      <div class="status-row">
        Based on ${(m.sources || []).length} retrieved papers.
        Open a source in the reading list to inspect the scholarly record.
      </div>
    </div>
  </article>`;
}

/* ── Render: main feed ── */
function renderFeed() {
  const chat = active();
  $('chatName').textContent = `› ${chat?.title || 'New chat'}`;
  const allMessages = chat?.messages || [];
  const node = selectedGalaxyNode();
  const visibleMessages = galaxyFilter
    ? allMessages.filter(message => messageMatchesGalaxyNode(message, node))
    : allMessages;
  const banner = galaxyFilter && node
    ? `<div class="feed-filter-banner">
        <span>Filtering feed by <b>${esc(node.label)}</b></span>
        <button type="button" id="clearGalaxyFilter">Clear filter</button>
      </div>`
    : '';
  const emptyFiltered = galaxyFilter && !visibleMessages.length
    ? `<div class="source-empty feed-filter-empty">No messages mention this node yet.</div>`
    : '';
  $('feed').innerHTML = !allMessages.length
    ? welcome()
    : banner + emptyFiltered + visibleMessages.map(messageHtml).join('');
  $('promptChips')?.querySelectorAll('button').forEach(b => b.onclick = () => send(b.textContent));
  $('clearGalaxyFilter')?.addEventListener('click', clearGalaxyFilter);
  bindGalaxyFeedMarks();
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
        <span>${Number(p.citations || 0).toLocaleString()} citations</span>
        ${p.openAccess ? '<span>Open access</span>' : ''}
      </div>
      <span class="source-link">Open full record ↗</span>
    </a>`).join('');
}

/* ── Research Galaxy graph ── */
function graphDisplayLabel(node) {
  if (node.type === 'paper') {
    const tag = node.label.match(/^\[P\d+\]/)?.[0] || '';
    const author = node.authors ? String(node.authors).split(/[;,]/)[0].trim() : '';
    return author ? `${tag} ${author}` : tag || node.label;
  }
  return node.label.length > 25 ? `${node.label.slice(0, 24).trim()}…` : node.label;
}

function highlightGalaxyNode(id) {
  if (!galaxySvg) return;
  const activeIdForHighlight = id || galaxySelectedId;
  const nodes = galaxyData.nodes;
  const links = galaxyData.links;
  if (!activeIdForHighlight) {
    galaxySvg.selectAll('.galaxy-node,.galaxy-link').classed('is-dim', false);
    return;
  }

  const connected = new Set([activeIdForHighlight]);
  links.forEach(link => {
    const source = typeof link.source === 'object' ? link.source.id : link.source;
    const target = typeof link.target === 'object' ? link.target.id : link.target;
    if (source === activeIdForHighlight) connected.add(target);
    if (target === activeIdForHighlight) connected.add(source);
  });
  galaxySvg.selectAll('.galaxy-node')
    .classed('is-dim', d => !connected.has(d.id))
    .classed('is-selected', d => d.id === galaxySelectedId);
  galaxySvg.selectAll('.galaxy-link')
    .classed('is-dim', link => {
      const source = typeof link.source === 'object' ? link.source.id : link.source;
      const target = typeof link.target === 'object' ? link.target.id : link.target;
      return source !== activeIdForHighlight && target !== activeIdForHighlight;
    });
}

function updateGalaxyDetail(node) {
  const detail = $('galaxyDetail');
  if (!detail) return;
  if (!node) {
    detail.hidden = true;
    return;
  }
  detail.hidden = false;
  $('detailDot').className = `detail-dot ${node.type}`;
  $('detailType').textContent = graphTypeLabel(node.type);
  $('detailTitle').textContent = node.label;
  const metadata = node.type === 'paper' && node.title
    ? `${node.title}${node.authors ? ` · ${node.authors}` : ''}${node.year ? ` · ${node.year}` : ''}`
    : `${node.count} ${node.count === 1 ? 'appearance' : 'appearances'} across this conversation`;
  $('detailMeta').textContent = metadata;
  $('filterFeedBtn').onclick = () => {
    galaxyFilter = node.id;
    renderFeed();
    requestAnimationFrame(() => $('feed').scrollTo({ top: 0, behavior: 'smooth' }));
  };
}

function selectGalaxyNode(id) {
  const node = galaxyData.nodes.find(item => item.id === id);
  if (!node) return;
  galaxySelectedId = id;
  updateGalaxyDetail(node);
  highlightGalaxyNode(id);
}

function clearGalaxyFilter() {
  galaxyFilter = null;
  renderFeed();
}

function fitGalaxyGraph() {
  if (!galaxySvg || !galaxyZoom || !galaxyZoomGroup || !galaxyData.nodes.length) return;
  const width = $('galaxyGraphCanvas').clientWidth;
  const height = $('galaxyGraphCanvas').clientHeight;
  const xs = galaxyData.nodes.map(node => node.x || width / 2);
  const ys = galaxyData.nodes.map(node => node.y || height / 2);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const graphWidth = Math.max(120, maxX - minX);
  const graphHeight = Math.max(120, maxY - minY);
  const scale = Math.min(1.15, Math.min((width - 58) / graphWidth, (height - 58) / graphHeight));
  const tx = width / 2 - ((minX + maxX) / 2) * scale;
  const ty = height / 2 - ((minY + maxY) / 2) * scale;
  galaxySvg.transition().duration(350).call(
    galaxyZoom.transform,
    d3.zoomIdentity.translate(tx, ty).scale(Math.max(.55, scale))
  );
}

function renderGalaxy() {
  const panel = $('galaxyPanel');
  const canvas = $('galaxyGraphCanvas');
  if (!panel || !canvas) return;
  $('galaxyNodeCount').textContent = galaxyData.nodes.length;
  $('galaxyBadge').textContent = galaxyData.nodes.length;
  $('galaxyBadge').hidden = !galaxyData.nodes.length;
  $('galaxyBadgeM').textContent = galaxyData.nodes.length;
  $('galaxyBadgeM').hidden = !galaxyData.nodes.length;
  $('galaxyEmpty').hidden = galaxyData.nodes.length > 0;
  panel.setAttribute('aria-hidden', document.body.classList.contains('galaxy-open') ? 'false' : 'true');

  if (typeof d3 === 'undefined') return;
  if (galaxySimulation) galaxySimulation.stop();
  canvas.replaceChildren();
  if (!galaxyData.nodes.length) {
    galaxySvg = null;
    galaxyZoom = null;
    galaxyZoomGroup = null;
    updateGalaxyDetail(null);
    return;
  }

  const width = Math.max(canvas.clientWidth, 300);
  const height = Math.max(canvas.clientHeight, 300);
  galaxySvg = d3.select(canvas).append('svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('aria-label', 'Research Galaxy network graph');
  galaxyZoomGroup = galaxySvg.append('g');
  galaxyZoom = d3.zoom().scaleExtent([.4, 2.6]).on('zoom', event => {
    galaxyZoomGroup.attr('transform', event.transform);
  });
  galaxySvg.call(galaxyZoom).on('dblclick.zoom', null);

  const link = galaxyZoomGroup.append('g').attr('aria-hidden', 'true')
    .selectAll('line').data(galaxyData.links).join('line')
    .attr('class', d => `galaxy-link ${d.relation}`)
    .attr('stroke-width', d => d.relation === 'contradicts' ? 1.8 : 1.25);

  const node = galaxyZoomGroup.append('g').attr('class', 'galaxy-nodes')
    .selectAll('g').data(galaxyData.nodes, d => d.id).join('g')
    .attr('class', 'galaxy-node')
    .attr('tabindex', 0)
    .attr('role', 'button')
    .attr('aria-label', d => `${graphTypeLabel(d.type)}: ${d.label}`)
    .on('click', (_, d) => selectGalaxyNode(d.id))
    .on('mouseenter', (_, d) => highlightGalaxyNode(d.id))
    .on('mouseleave', () => highlightGalaxyNode(galaxySelectedId))
    .on('focus', (_, d) => highlightGalaxyNode(d.id))
    .on('blur', () => highlightGalaxyNode(galaxySelectedId))
    .on('keydown', (event, d) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectGalaxyNode(d.id);
      }
    })
    .call(d3.drag()
      .on('start', (event, d) => {
        if (!event.active) galaxySimulation.alphaTarget(.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end', (event, d) => {
        if (!event.active) galaxySimulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      }));

  node.append('circle')
    .attr('r', d => Math.min(16, 7 + Math.sqrt(d.count) * 2))
    .attr('fill', d => GALAXY_COLORS[d.type]);
  node.append('text')
    .attr('class', d => d.type === 'paper' ? 'paper-label' : '')
    .attr('x', d => 10 + Math.min(8, Math.sqrt(d.count)))
    .attr('y', 3)
    .text(graphDisplayLabel);
  node.append('title').text(d => `${graphTypeLabel(d.type)}: ${d.label}`);

  galaxySimulation = d3.forceSimulation(galaxyData.nodes)
    .force('link', d3.forceLink(galaxyData.links).id(d => d.id).distance(72).strength(.6))
    .force('charge', d3.forceManyBody().strength(-120))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide().radius(d => 18 + Math.sqrt(d.count) * 2).strength(.9))
    .on('tick', () => {
      link
        .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
      node.attr('transform', d => `translate(${d.x},${d.y})`);
    })
    .on('end', fitGalaxyGraph);

  if (galaxySelectedId) {
    updateGalaxyDetail(selectedGalaxyNode());
    highlightGalaxyNode(galaxySelectedId);
  }
}

function resizeGalaxyGraph() {
  if (!galaxySvg || !galaxySimulation) return;
  const canvas = $('galaxyGraphCanvas');
  const width = Math.max(canvas.clientWidth, 300);
  const height = Math.max(canvas.clientHeight, 300);
  galaxySvg.attr('viewBox', `0 0 ${width} ${height}`);
  galaxySimulation.force('center', d3.forceCenter(width / 2, height / 2)).alpha(.15).restart();
  window.clearTimeout(window._galaxyFitTimer);
  window._galaxyFitTimer = window.setTimeout(fitGalaxyGraph, 180);
}

function bindGalaxyFeedMarks() {
  $('feed').querySelectorAll('[data-galaxy-node]').forEach(mark => {
    const id = mark.dataset.galaxyNode;
    mark.addEventListener('mouseenter', () => highlightGalaxyNode(id));
    mark.addEventListener('mouseleave', () => highlightGalaxyNode(galaxySelectedId));
    mark.addEventListener('focus', () => highlightGalaxyNode(id));
    mark.addEventListener('blur', () => highlightGalaxyNode(galaxySelectedId));
    mark.addEventListener('click', () => selectGalaxyNode(id));
  });
}

function renderAll() {
  rebuildGalaxyData();
  renderChats();
  renderFeed();
  renderSources();
  renderGalaxy();
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

  function syncGalaxyPanelState() {
    const open = body.classList.contains('galaxy-open');
    $('galaxyToggle')?.setAttribute('aria-expanded', String(open));
    $('galaxyPanel')?.setAttribute('aria-hidden', String(!open));
  }
  function closeAll() {
    body.classList.remove('nav-open', 'src-open', 'galaxy-open');
    syncGalaxyPanelState();
  }
  function toggle(cls) { const on = body.classList.contains(cls); closeAll(); if (!on) body.classList.add(cls); }

  $('navToggle').onclick = () => toggle('nav-open');
  $('srcToggle').onclick = () => toggle('src-open');
  $('galaxyToggle').onclick = () => { toggle('galaxy-open'); syncGalaxyPanelState(); };
  $('galaxyToggleM').onclick = () => { toggle('galaxy-open'); syncGalaxyPanelState(); };
  $('galaxyClose').onclick = closeAll;
  $('galaxyReset').onclick = fitGalaxyGraph;
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
  window.addEventListener('resize', () => { if (isMobile()) syncGalaxyPanelState(); });
  window.addEventListener('resize', resizeGalaxyGraph);

  /* Sync mobile header with desktop state */
  function sync() {
    $('mChatName').textContent =
      ($('chatName').textContent || '').replace(/^›\s*/, '') || 'New conversation';
    const n     = Number($('sourceCount').textContent || 0);
    const badge = $('srcBadge');
    badge.textContent = n;
    badge.hidden      = !n;
    const galaxyCount = Number($('galaxyNodeCount').textContent || 0);
    $('galaxyBadgeM').textContent = galaxyCount;
    $('galaxyBadgeM').hidden = !galaxyCount;
    syncGalaxyPanelState();
  }

  const _renderAll    = renderAll;
  renderAll = function () { _renderAll.apply(this, arguments); sync(); };

  const _renderSources = renderSources;
  renderSources = function () { _renderSources.apply(this, arguments); sync(); };

  sync();
  document.querySelectorAll('[data-galaxy-type]').forEach(button => {
    button.addEventListener('click', () => {
      const type = button.dataset.galaxyType;
      const isActive = button.classList.toggle('is-active');
      document.querySelectorAll('[data-galaxy-type]').forEach(other => {
        if (other !== button) other.classList.remove('is-active');
      });
      if (!galaxySvg) return;
      galaxySvg.selectAll('.galaxy-node').classed('is-dim', d => isActive ? d.type !== type : false);
      galaxySvg.selectAll('.galaxy-link').classed('is-dim', isActive);
    });
  });

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
