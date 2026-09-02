/**
 * Prior Work & Semantic Match Assistant — server route
 * ----------------------------------------------------
 * Mount in your existing Express server (the same one that serves /api/chat):
 *
 *   const priorWork = require('./prior-work');      // CommonJS
 *   app.use(priorWork);
 *
 *   // or, for ESM servers:
 *   // import priorWork from './prior-work.js';
 *   // app.use(priorWork);
 *
 * Environment:
 *   GEMINI_API_KEY   required
 *   GEMINI_MODEL     optional (default: gemini-2.5-flash)
 *   OPENALEX_MAILTO  optional but recommended — puts you in OpenAlex's polite pool
 *
 * Pipeline:
 *   user draft -> [Gemini #1] optimised search_query
 *              -> [OpenAlex] GET /works?search.semantic=...&per-page=5
 *              -> reconstruct abstracts from inverted index
 *              -> [Gemini #2] strict-JSON overlap report
 *              -> JSON response rendered by the client
 */

const express = require('express');

const router = express.Router();

const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_KEY     = process.env.GEMINI_API_KEY;
const MAILTO         = process.env.OPENALEX_MAILTO || '';
const MAX_QUERY_CHARS = 1200;   // hard cap; OpenAlex limit is 1500
const PER_PAGE        = 5;

const DISCLAIMER =
  'This analysis is based on available titles, abstracts, and metadata indexed in OpenAlex ' +
  '(250M+ records). It does not scan full paywalled paper bodies.';

/* ── Gemini helper ── */
async function gemini(systemPrompt, userPrompt, { json = true } = {}) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY is not configured on the server.');

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.2,
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini request failed [${res.status}]: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '')
    .join('')
    .trim();

  if (!text) throw new Error('Gemini returned an empty response.');
  if (!json) return text;

  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Gemini did not return valid JSON.');
  }
}

/* ── Stage 1: query formulation ── */
const QUERY_SYSTEM = `You are the "Prior Work & Semantic Match Assistant" for an academic paper platform.
Stage 1 of your job: read a submitted paper title and draft text, identify the core hypothesis,
key domain terms, methodology and findings, and compress them into ONE dense search phrase
optimised for the OpenAlex semantic search endpoint.

Rules:
- Maximum 200 words and 1200 characters. Shorter is better.
- No quotes, no boolean operators, no field prefixes, no citations, no markdown.
- Keep domain-specific terminology, method names, datasets, populations and outcome measures.
- Drop filler, hedging, self-references ("in this paper we...") and formatting artefacts.

Return strict JSON only: {"search_query": "..."}`;

/* ── Stage 2: overlap analysis ── */
const ANALYSIS_SYSTEM = `You are the "Semantic Overlap & Literature Citation Finder" for an academic paper platform.
You are NOT a legal or academic plagiarism verdict engine. Never claim full-text coverage and never
issue an accusation. Frame everything as "semantic similarity matches" or "potential prior work".

You receive the user's submitted title and draft text plus candidate papers retrieved from OpenAlex
(title, abstract, authors, venue, year, URL). For each candidate:
- Compare the user's text against the candidate's title and abstract.
- Assign similarity_level of "High", "Medium" or "Low" based on topic & methodology overlap,
  verbatim or near-verbatim phrasing, and shared domain terminology and claims.
- List concrete overlapping concepts, quoting or paraphrasing the specific phrasing from the
  user's input that overlaps with that candidate.

Then set match_status to HIGH_OVERLAP, MEDIUM_OVERLAP, LOW_OVERLAP or NO_MATCHES_FOUND, and write a
concise summary stating whether the submission appears to build upon, heavily mirror, or merely
resemble existing literature.

Return STRICT JSON only, exactly this shape:
{
  "search_query": "string",
  "match_status": "HIGH_OVERLAP | MEDIUM_OVERLAP | LOW_OVERLAP | NO_MATCHES_FOUND",
  "summary": "string",
  "matched_papers": [
    {
      "openalex_id": "string",
      "title": "string",
      "authors": "string",
      "publication_year": 2024,
      "similarity_level": "High | Medium | Low",
      "overlapping_concepts": ["string"],
      "url": "string"
    }
  ],
  "disclaimer": "${DISCLAIMER}"
}`;

/* ── OpenAlex helpers ── */
function reconstructAbstract(inverted) {
  if (!inverted) return '';
  const slots = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const pos of positions) slots[pos] = word;
  }
  return slots.join(' ').replace(/\s+/g, ' ').trim();
}

async function openAlexSearch(query) {
  const base = 'https://api.openalex.org/works';
  const common = `per-page=${PER_PAGE}${MAILTO ? `&mailto=${encodeURIComponent(MAILTO)}` : ''}`;
  const attempts = [
    `${base}?search.semantic=${encodeURIComponent(query)}&${common}`,
    `${base}?search=${encodeURIComponent(query)}&${common}`, // fallback: keyword search
  ];

  let lastError = '';
  for (const url of attempts) {
    const res = await fetch(url, { headers: { 'User-Agent': `Epistemia AI (${MAILTO || 'contact unset'})` } });
    if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }
    const data = await res.json();
    if (Array.isArray(data.results)) return data.results;
  }
  throw new Error(`OpenAlex search failed (${lastError || 'no results payload'}).`);
}

function normaliseWork(w) {
  const authors = (w.authorships || [])
    .map(a => a.author?.display_name)
    .filter(Boolean)
    .slice(0, 6)
    .join(', ');

  return {
    openalex_id: w.id || '',
    title:       w.display_name || w.title || 'Untitled record',
    abstract:    reconstructAbstract(w.abstract_inverted_index).slice(0, 2000),
    authors:     authors || 'Authors unavailable',
    publication_year: w.publication_year || null,
    venue:       w.primary_location?.source?.display_name || 'Venue unavailable',
    url:         w.primary_location?.landing_page_url || w.doi || w.id || '',
    citations:   w.cited_by_count || 0,
    open_access: !!w.open_access?.is_oa,
  };
}

/* ── Route ── */
router.post('/api/prior-work', express.json({ limit: '1mb' }), async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const text  = String(req.body?.text  || '').trim();

  if (title.length < 3)  return res.status(400).json({ error: 'A paper title is required.' });
  if (text.length  < 80) return res.status(400).json({ error: 'Provide at least a paragraph of draft text.' });

  try {
    /* Step 1 — query formulation */
    const draft = `TITLE: ${title}\n\nDRAFT TEXT:\n${text.slice(0, 30000)}`;
    const stage1 = await gemini(QUERY_SYSTEM, draft);
    let searchQuery = String(stage1.search_query || title).replace(/\s+/g, ' ').trim();
    if (searchQuery.length > MAX_QUERY_CHARS) searchQuery = searchQuery.slice(0, MAX_QUERY_CHARS).trim();

    /* Step 2 & 3 — OpenAlex retrieval + metadata extraction */
    const works      = await openAlexSearch(searchQuery);
    const candidates = works.map(normaliseWork);

    if (!candidates.length) {
      return res.json({
        search_query:   searchQuery,
        match_status:   'NO_MATCHES_FOUND',
        summary:        'OpenAlex returned no indexed records that semantically match this draft. ' +
                        'Try broadening the draft text or including more domain terminology.',
        matched_papers: [],
        disclaimer:     DISCLAIMER,
      });
    }

    /* Step 4 — overlap analysis */
    const analysisPrompt =
      `USER SUBMISSION\nTitle: ${title}\n\nText:\n${text.slice(0, 20000)}\n\n` +
      `SEARCH QUERY USED: ${searchQuery}\n\n` +
      `OPENALEX CANDIDATES (JSON):\n${JSON.stringify(
        candidates.map(({ citations, open_access, ...c }) => c), null, 2)}`;

    const report = await gemini(ANALYSIS_SYSTEM, analysisPrompt);

    /* Merge retrieval metadata back in so the reading list can render stats */
    const byId = new Map(candidates.map(c => [c.openalex_id, c]));
    const matched = (report.matched_papers || []).map(p => {
      const src = byId.get(p.openalex_id) || {};
      return {
        openalex_id:          p.openalex_id || src.openalex_id || '',
        title:                p.title || src.title,
        authors:              p.authors || src.authors,
        publication_year:     p.publication_year ?? src.publication_year,
        similarity_level:     p.similarity_level || 'Low',
        overlapping_concepts: Array.isArray(p.overlapping_concepts) ? p.overlapping_concepts : [],
        url:                  p.url || src.url || src.openalex_id || '',
        venue:                src.venue,
        citations:            src.citations || 0,
        open_access:          !!src.open_access,
      };
    });

    res.json({
      search_query:   report.search_query || searchQuery,
      match_status:   report.match_status || 'LOW_OVERLAP',
      summary:        report.summary || '',
      matched_papers: matched,
      disclaimer:     DISCLAIMER,
    });
  } catch (err) {
    console.error('[prior-work]', err);
    res.status(502).json({ error: err.message || 'Prior work analysis failed.' });
  }
});

module.exports = router;
