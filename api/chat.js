const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models';
const LLM_MODEL    = 'gemini-3.5-flash-lite';
const OPENALEX_URL = 'https://api.openalex.org/works';

/* ── Utilities ── */

function cleanJson(t) {
  return String(t || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

async function llmJson(prompt, maxOutputTokens, apiKey) {
  const url = `${GEMINI_BASE}/${encodeURIComponent(LLM_MODEL)}:generateContent`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body:    JSON.stringify({
      contents:         [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature:      0.12,
        responseMimeType: 'application/json',
        maxOutputTokens,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(data.error?.message || `Gemini returned HTTP ${res.status}.`);
  const text = (data.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
  return JSON.parse(cleanJson(text));
}

function recentHistory(history) {
  return (history || []).slice(-4).map(m => `${m.role}: ${m.content}`).join('\n');
}

/* ── Interpretation ── */

function conceptVariants(term) {
  const t = String(term || '').toLowerCase();
  const v = [t];
  if (/spectroscop|spectral|spectrum|spectra/.test(t))
    v.push('spectroscopy', 'spectrum', 'spectra', 'gaia xp');
  if (/hertzsprung|hr diagram|stellar evolution/.test(t))
    v.push('hertzsprung', 'hr diagram', 'stellar evolution', 'main sequence');
  if (/stellar classification|star classification|stellar label/.test(t))
    v.push('stellar classification', 'star classification', 'stellar parameter', 'stellar label', 'star type');
  if (/machine learning|neural network/.test(t))
    v.push('machine learning', 'deep learning', 'artificial intelligence', 'neural network');
  if (/astrophys|astronom/.test(t))
    v.push('astrophysics', 'astronomy', 'stellar');
  return [...new Set(v)];
}

async function interpret(question, history, apiKey) {
  const prompt =
    `You are the query-planning step of a scholarly research assistant. ` +
    `Classify the user's question as broad or specific, then create a faithful search plan. ` +
    `Broad means a short named topic or general overview request. ` +
    `Specific means the question contains a concrete task, data type, population, method, ` +
    `mechanism, comparison, outcome, or multiple linked constraints. ` +
    `Preserve the user's exact scientific nouns and relationships. ` +
    `Return JSON only: {"topic":"short topic label","specificity":"broad|specific",` +
    `"searchQuery":"6 to 16 word scholarly keyword query",` +
    `"requiredTerms":["3 to 8 essential concepts or short phrases"],"intent":"short explanation"}. ` +
    `Work carefully and deliberately: before writing the JSON, mentally restate the question, ` +
    `list every constraint it contains (task, data type, population, method, mechanism, comparison, ` +
    `outcome, timeframe), and check that your search plan covers each one. Accuracy of the plan ` +
    `matters far more than speed. ` +
    `Do not answer the user's question or include citations.\n\n` +
    `Recent chat:\n${recentHistory(history)}\n\nLatest message:\n${question}`;

  const raw = await llmJson(prompt, 800, apiKey);

  const text      = String(question || '');
  const heuristic =
    (text.length > 120 ? 1 : 0) +
    (/\bhow\b|\busing\b|\bthrough\b|\bfrom\b|\bclassif|\btrain|\bcompare|\bdetect|\brecogniz/i.test(text) ? 1 : 0) +
    ((text.match(/\band\b|\bor\b|\bwith\b/gi) || []).length >= 2 ? 1 : 0);
  const specificity = raw.specificity === 'specific' || heuristic >= 2 ? 'specific' : 'broad';

  const explicitTerms = text.match(
    /machine learning|deep learning|spectroscop\w*|spectral\w*|spectr\w*|image\w*|distant stars?|stellar classification|star classification|hertzsprung[–— -]?russell|hr diagram\w*|astronom\w*|astrophys\w*|classif\w*/gi
  ) || [];

  const requiredTerms = [
    ...(Array.isArray(raw.requiredTerms) ? raw.requiredTerms : []),
    ...explicitTerms,
    ...text.split(/[,;()]|\s+and\s+|\s+through\s+/i).map(x => x.trim()).filter(x => x.length > 3),
  ]
    .map(x => String(x).replace(/^[^a-z0-9]+|[^a-z0-9%+–—-]+$/gi, '').trim())
    .filter(Boolean)
    .filter((x, i, a) => a.findIndex(y => y.toLowerCase() === x.toLowerCase()) === i)
    .slice(0, 8);

  return {
    topic:        String(raw.topic || 'Research question'),
    specificity,
    searchQuery:  String(raw.searchQuery || question).trim().slice(0, 260) || question,
    requiredTerms,
    intent:       String(raw.intent || 'Searching related scholarly evidence.'),
  };
}

/* ── Second pass: critique and sharpen the search plan ── */

async function refinePlan(question, interpretation, apiKey) {
  const prompt =
    `You are the plan-review step of a scholarly research assistant. ` +
    `Critically review the draft search plan below against the user's question. ` +
    `Check for: missing constraints, terms the user never asked about, over-broad wording, ` +
    `missing synonyms or field-standard terminology, and whether the query would surface ` +
    `papers that actually answer the question. ` +
    `Then return an improved plan. Keep the user's exact scientific nouns and relationships. ` +
    `Return JSON only: {"searchQuery":"6 to 18 word scholarly keyword query",` +
    `"requiredTerms":["3 to 8 essential concepts"],"topic":"short topic label",` +
    `"specificity":"broad|specific","rationale":"one short sentence on what you changed"}.\n\n` +
    `User question: ${question}\n\n` +
    `Draft plan:\n${JSON.stringify(interpretation, null, 2)}`;

  let raw;
  try { raw = await llmJson(prompt, 700, apiKey); }
  catch { return interpretation; }

  const terms = [
    ...(Array.isArray(raw.requiredTerms) ? raw.requiredTerms : []),
    ...(interpretation.requiredTerms || []),
  ]
    .map(x => String(x || '').trim())
    .filter(Boolean)
    .filter((x, i, a) => a.findIndex(y => y.toLowerCase() === x.toLowerCase()) === i)
    .slice(0, 8);

  return {
    ...interpretation,
    topic:         String(raw.topic || interpretation.topic),
    specificity:   raw.specificity === 'specific' || raw.specificity === 'broad'
                     ? raw.specificity : interpretation.specificity,
    searchQuery:   String(raw.searchQuery || interpretation.searchQuery).trim().slice(0, 280)
                     || interpretation.searchQuery,
    requiredTerms: terms.length ? terms : interpretation.requiredTerms,
    rationale:     String(raw.rationale || 'Search plan reviewed and confirmed.'),
  };
}

/* ── OpenAlex retrieval ── */

function normalizeWork(w) {
  function authorNames(items = []) {
    const names = items.map(x => x.author?.display_name).filter(Boolean);
    return names.slice(0, 3).join(', ') + (names.length > 3 ? ' et al.' : '') || 'Authors not listed';
  }
  function makeAbstract(index) {
    if (!index) return 'Abstract unavailable for this scholarly record.';
    const words = [];
    Object.entries(index).forEach(([w, p]) => p.forEach(i => (words[i] = w)));
    return words.filter(Boolean).join(' ') || 'Abstract unavailable for this scholarly record.';
  }
  return {
    id:             w.id || String(Math.random()),
    title:          w.title || 'Untitled scholarly work',
    authors:        authorNames(w.authorships),
    abstract:       makeAbstract(w.abstract_inverted_index),
    year:           w.publication_year || null,
    date:           w.publication_date || null,
    citations:      Number(w.cited_by_count || 0),
    relevanceScore: Number(w.relevance_score || 0),
    openAccess:     Boolean(w.open_access?.is_oa),
    venue:          w.primary_location?.source?.display_name || null,
    url:            w.open_access?.oa_url || w.primary_location?.landing_page_url || w.doi || w.id || '#',
  };
}

function searchVariants(question, interpretation) {
  const clean = v => String(v || '').replace(/[?*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 260);
  const focused  = clean(interpretation.searchQuery);
  const concepts = clean(
    Array.isArray(interpretation.requiredTerms)
      ? interpretation.requiredTerms.filter(Boolean).slice(0, 8).join(' ')
      : ''
  );
  const original = clean(question);
  return [...new Set([focused, concepts, original].filter(Boolean))];
}

function paperTermCoverage(paper, terms = []) {
  const text = `${paper.title} ${paper.abstract}`.toLowerCase();
  return terms.reduce(
    (hits, term) => hits + (conceptVariants(term).some(v => text.includes(v)) ? 1 : 0),
    0
  );
}

async function retrieve(question, interpretation, scholarApiKey) {
  const variants = searchVariants(question, interpretation);

  const fetchVariant = async query => {
    const url = new URL(OPENALEX_URL);
    url.searchParams.set('search',   query);
    url.searchParams.set('per-page', '20');
    url.searchParams.set('sort',     'relevance_score:desc');
    url.searchParams.set('select',
      'id,title,authorships,abstract_inverted_index,publication_date,publication_year,' +
      'cited_by_count,relevance_score,open_access,primary_location,doi');
    if (scholarApiKey) url.searchParams.set('api_key', scholarApiKey);

    const r    = await fetch(url.toString());
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || data.error || `OpenAlex returned HTTP ${r.status}.`);
    return (data.results || []).map(normalizeWork);
  };

  const results = await Promise.allSettled(variants.map(fetchVariant));

  const merged = [];
  const seen   = new Set();
  results.forEach(result => {
    if (result.status !== 'fulfilled') return;
    result.value.forEach(p => {
      const key = String(p.title || p.id).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!seen.has(key)) { seen.add(key); merged.push(p); }
    });
  });

  if (!merged.length) {
    const failure = results.find(x => x.status === 'rejected');
    throw new Error(failure?.reason?.message || 'No scholarly records were returned from the full-corpus search.');
  }

  const terms  = Array.isArray(interpretation.requiredTerms)
    ? interpretation.requiredTerms.filter(Boolean).slice(0, 8) : [];
  const ranked = merged
    .map(p => ({ ...p, termCoverage: paperTermCoverage(p, terms) }))
    .sort((a, b) =>
      b.termCoverage - a.termCoverage ||
      b.relevanceScore - a.relevanceScore ||
      b.citations - a.citations);

  const target  = interpretation.specificity === 'specific' ? 10 : 20;
  const minimum = interpretation.specificity === 'specific' && terms.length >= 4
    ? Math.max(2, Math.ceil(terms.length * 0.35)) : 0;
  const focused = minimum ? ranked.filter(p => p.termCoverage >= minimum) : ranked;

  return (focused.length >= Math.min(target, 9) ? focused : ranked).slice(0, target);
}

/* ── Synthesis ── */

function sourceText(p, i) {
  return `[P${i + 1}] ${p.title}. ${p.authors} (${p.year || 'n.d.'}). ` +
    `${p.venue || 'Venue unavailable'}. Abstract: ${String(p.abstract || 'Abstract unavailable.').slice(0, 900)}`;
}

function safeAnswer(raw, papers) {
  const fallback = {
    answer:      '**Insufficient evidence.** The retrieved records did not support a citation-safe answer. Review the linked papers and refine your question.',
    status:      'insufficient',
    agreement:   'No reliable agreement signal is available.',
    limitations: ['The response did not satisfy the paper-citation safety check.'],
  };
  if (!raw || typeof raw.answer !== 'string' || !['supported', 'mixed', 'insufficient'].includes(raw.status))
    return fallback;
  const cited = [...raw.answer.matchAll(/\[P(\d+)\]/g)].map(m => Number(m[1]));
  if (raw.status !== 'insufficient' && (!cited.length || cited.some(n => n < 1 || n > papers.length)))
    return fallback;
  return {
    answer:      raw.answer,
    status:      raw.status,
    agreement:   raw.agreement || 'No agreement statement was returned.',
    limitations: Array.isArray(raw.limitations) && raw.limitations.length
      ? raw.limitations
      : ['Abstracts and metadata do not replace full-text source review.'],
  };
}

async function synthesize(question, interpretation, papers, history, apiKey) {
  const prompt =
    `You are Epyvora AI, a warm but concise academic research companion. ` +
    `Answer only the user's research question. ` +
    `Use conversation history only to understand follow-up intent; use ONLY the current supplied papers for factual claims. ` +
    `Read every supplied paper carefully before answering; weigh agreement and disagreement across them rather than paraphrasing the first match. ` +
    `Answer in at most 4 concise sentences or bullets. ` +
    `Return JSON only: {"answer":"markdown","status":"supported|mixed|insufficient","agreement":"short sentence","limitations":["item"]}. ` +
    `Every factual sentence must include valid [P1] citations tied to the supplied papers. ` +
    `If evidence is weak or cannot answer the question, choose insufficient.\n\n` +
    `Recent chat history:\n${recentHistory(history)}\n\n` +
    `Current question: ${question}\n` +
    `Interpreted topic: ${interpretation.topic}\n` +
    `Scholarly search focus: ${interpretation.searchQuery}\n` +
    `Search specificity: ${interpretation.specificity}\n` +
    `Required concepts: ${(interpretation.requiredTerms || []).join(', ')}\n\n` +
    `Current retrieved papers:\n${papers.map(sourceText).join('\n\n')}`;

  return safeAnswer(await llmJson(prompt, 1400, apiKey), papers);
}

/* ── Vercel handler — streams NDJSON progress events ── */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const scholarApiKey = process.env.SCHOLAR_API_KEY || '';
  const llmApiKey     = process.env.LLM_API_KEY     || '';

  if (!llmApiKey) {
    return res.status(500).json({ error: 'LLM_API_KEY is not configured on the server.' });
  }

  const { question, history } = req.body || {};

  if (!question || typeof question !== 'string' || question.trim().length < 3) {
    return res.status(400).json({ error: 'Provide a question with at least three characters.' });
  }

  /* ── Open a chunked stream so the client sees live progress ── */
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx/proxy buffering

  const emit = obj => res.write(JSON.stringify(obj) + '\n');

  try {
    /* Stage 0 — tell the client we have started reading the question */
    emit({ event: 'planning' });

    /* Stage 1 — interpret */
    const draft = await interpret(question.trim(), history, llmApiKey);
    emit({
      event:       'interpreted',
      searchQuery: draft.searchQuery,
      specificity: draft.specificity,
      topic:       draft.topic,
    });

    /* Stage 1b — review and sharpen the plan before searching */
    const interpretation = await refinePlan(question.trim(), draft, llmApiKey);
    emit({
      event:       'refined',
      searchQuery: interpretation.searchQuery,
      specificity: interpretation.specificity,
      topic:       interpretation.topic,
      rationale:   interpretation.rationale || '',
      terms:       interpretation.requiredTerms || [],
    });

    /* Stage 2 — retrieve */
    let papers = [];
    try {
      papers = await retrieve(question.trim(), interpretation, scholarApiKey);
      emit({ event: 'searching', count: papers.length });
      emit({ event: 'reading', count: papers.length });
    } catch (retrievalErr) {
      emit({
        event:       'result',
        answer:      '**Insufficient evidence.** I could not retrieve relevant scholarly records for this interpreted topic. Try adding a population, outcome, timeframe, or study context.',
        status:      'insufficient',
        agreement:   'No source set was retrieved.',
        limitations: ['No matching scholarly records were returned.'],
        sources:     [],
        searchQuery: interpretation.searchQuery,
        specificity: interpretation.specificity,
      });
      return res.end();
    }

    /* Stage 3 — synthesise */
    const synthesis = await synthesize(question.trim(), interpretation, papers, history, llmApiKey);
    emit({
      event:       'result',
      ...synthesis,
      sources:     papers,
      searchQuery: interpretation.searchQuery,
      specificity: interpretation.specificity,
    });

  } catch (err) {
    console.error('[api/chat] Error:', err);
    emit({ event: 'error', error: err.message || 'An unexpected server error occurred.' });
  }

  res.end();
}
