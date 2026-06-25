/* ═══════════════════════════════════════════════════════════════════
   ExamForge — app.js
   Full MCQ Quiz Engine: PDF extraction → parsing → quiz engine
   Architecture:
     PDFExtractor       – pdf.js wrapper, async page-by-page
     TextNormalizer     – clean raw text (headers, hyphens, noise)
     BlockDetector      – segment text into question blocks
     OptionReconstructor– rebuild multi-line options
     QuestionParser     – assemble final MCQ objects
     ValidationSystem   – score confidence, flag review
     Storage            – IndexedDB-backed question bank
     QuizEngine         – quiz state machine
     UI                 – screen controller
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ─── pdf.js worker setup ───────────────────────────────────────── */
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ═══════════════════════════════════════════════════════════════════
   1. PDF EXTRACTOR
   ═══════════════════════════════════════════════════════════════════ */
const PDFExtractor = {
  /**
   * Extract raw text per page from ArrayBuffer.
   * Returns: [{ page: number, text: string }]
   */
  async extract(arrayBuffer, onProgress) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // Reconstruct lines with position hinting
      const items = content.items;
      let text = this._itemsToText(items);
      pages.push({ page: i, text });
      if (onProgress) onProgress(i, pdf.numPages);
    }
    return pages;
  },

  /**
   * Convert pdf.js text items to a string that preserves line breaks.
   * Items are sorted by vertical then horizontal position.
   */
  _itemsToText(items) {
    if (!items.length) return '';

    // Detect two-column layout: gap in the middle X band = two columns
    const xs = items.map(i => i.transform[4]);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const pageWidth = xMax - xMin;
    const midX = xMin + pageWidth / 2;
    const midCount = items.filter(i => {
      const x = i.transform[4];
      return x > xMin + pageWidth * 0.35 && x < xMin + pageWidth * 0.65;
    }).length;
    const isTwoCol = pageWidth > 200 && midCount < items.length * 0.08;

    if (isTwoCol) {
      const left  = items.filter(i => i.transform[4] <  midX);
      const right = items.filter(i => i.transform[4] >= midX);
      // Output each column top-to-bottom, separated by a blank line
      return [this._colToText(left), this._colToText(right)].filter(Boolean).join('\n\n');
    }
    return this._colToText(items);
  },

  _colToText(items) {
    if (!items.length) return '';
    const TOL = 4;
    const lines = [];
    let curY = null, curLine = [];
    const sorted = [...items].sort((a, b) => {
      const ya = Math.round(a.transform[5] / TOL) * TOL;
      const yb = Math.round(b.transform[5] / TOL) * TOL;
      if (ya !== yb) return yb - ya;
      return a.transform[4] - b.transform[4];
    });
    for (const item of sorted) {
      const y = Math.round(item.transform[5] / TOL) * TOL;
      if (curY === null) { curY = y; curLine = [item]; }
      else if (Math.abs(y - curY) <= TOL) { curLine.push(item); }
      else {
        lines.push(curLine.map(i => i.str).join(' ').trim());
        curY = y; curLine = [item];
      }
    }
    if (curLine.length) lines.push(curLine.map(i => i.str).join(' ').trim());
    return lines.filter(l => l).join('\n');
  }
};

/* ═══════════════════════════════════════════════════════════════════
   2. TEXT NORMALIZER
   ═══════════════════════════════════════════════════════════════════ */
const TextNormalizer = {
  /**
   * Clean a page's raw text.
   * Strips CBSE exam noise, fixes hyphens, normalises whitespace.
   */

  // Noise patterns matched per-line and stripped before block detection
  NOISE_PATTERNS: [
    /downloaded\s+from/i,
    /www\.[a-z0-9\-]+\.(com|in|org|net|tube)/i,
    /cbse\s+(chapter|sample|board|chapterwise)/i,
    /^(section|part)\s*[-]?\s*[a-z]\b/i,
    /^(section|part)\s*[-]?\s*[ivx]+\b/i,
    /^objective\s+questions?$/i,
    /^ch(apter)?\s*\d+\s*:/i,
    /^(delhi|od|comp|all\s*india)\s*(20\d\d)?/i,
    /^thus\s+\([a-e]\)\s+is/i,
    /^page\s+\d+$/i,
    /^\d{1,3}\s*$/,
    /^[-=*#]{3,}$/,
    /^(marks?|time\s+allowed|general\s+instructions|roll\s*no)/i,
    /^(class|subject|date)\s*:/i,
  ],

  isNoiseLine(line) {
    return this.NOISE_PATTERNS.some(r => r.test(line.trim()));
  },

  normalize(text, pageNum) {
    let t = text;

    // Fix hyphenated line-breaks: "infor-\nmation" → "information"
    t = t.replace(/(\w)-\n(\w)/g, '$1$2');

    // Normalise unicode punctuation
    t = t.replace(/[\u2013\u2014]/g, '-');
    t = t.replace(/[\u201c\u201d]/g, '"');
    t = t.replace(/[\u2018\u2019]/g, "'");

    // Strip noise lines + ALL-CAPS headers per line
    t = t.split('\n').map(l => {
      const line = l.trim();
      if (!line) return '';
      if (this.isNoiseLine(line)) return '';
      // ALL-CAPS header heuristic (not numbered lines)
      if (/^[A-Z][A-Z\s\-]{5,60}[A-Z]$/.test(line) && !/^\d/.test(line)) return '';
      return line;
    }).join('\n');

    // Collapse 3+ blank lines to 2
    t = t.replace(/\n{3,}/g, '\n\n');

    return t;
  }
};

/* ═══════════════════════════════════════════════════════════════════
   3. BLOCK DETECTOR
   Identifies where new questions start and groups lines accordingly.
   ═══════════════════════════════════════════════════════════════════ */
const BlockDetector = {
  /* Patterns that signal the START of a new question */
  QUESTION_START: [
    /^Q\.?\s*\d+[.):\s]/i,              // Q1. Q1) Q1:
    /^\d{1,3}[.)]\s/,                    // 1. 2) 3.
    /^\d{1,3}\s+[A-Z\("]/,              // 1 What... / 1 "The...
    /^\(\s*\d{1,3}\s*\)/,              // (1) (12)
    /^Question\s+\d+/i,                  // Question 1
    /^\[?\d{1,3}\]?\./,                // [1].
  ],

  /* Patterns that signal the START of an option */
  OPTION_START: [
    /^\(?[A-Da-d]\s*[.):\-]\s+\S/,   // A. A) A: (A) — must have content after space
    /^[\u2460\u2461\u2462\u2463]/,     // circled numbers ①②③④
  ],

  /* Lines to skip even inside a valid block */
  BLOCK_NOISE: [
    /^(od|delhi|comp|all\s*india)\s*20\d\d/i,
    /^downloaded\s+from/i,
    /^(marks?|time\s+allowed|general\s+instructions)/i,
  ],

  isQuestionStart(line) {
    if (this.isOptionStart(line)) return false; // options can't trigger a new question
    return this.QUESTION_START.some(r => r.test(line));
  },

  isOptionStart(line) {
    return this.OPTION_START.some(r => r.test(line));
  },

  /**
   * Split normalised pages into question blocks.
   * Each block: { lines: string[], page: number, rawStart: string }
   */
  detect(normalizedPages) {
    const blocks = [];
    let current = null;

    for (const { page, text } of normalizedPages) {
      const lines = text.split('\n');

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // Hard-skip global noise + block-local noise
        if (TextNormalizer.isNoiseLine(line)) continue;
        if (this.BLOCK_NOISE.some(r => r.test(line))) continue;

        if (this.isQuestionStart(line)) {
          if (current) blocks.push(current);
          current = { lines: [line], page, rawStart: line };
        } else if (current) {
          current.lines.push(line);
        }
      }
    }
    if (current) blocks.push(current);

    return blocks;
  }
};

/* ═══════════════════════════════════════════════════════════════════
   4. OPTION RECONSTRUCTOR
   Given a block's lines[], separates question stem from options,
   handling multi-line continuations.
   ═══════════════════════════════════════════════════════════════════ */
const OptionReconstructor = {
  /* Normalize a raw option label to A/B/C/D/E */
  normalizeKey(raw) {
    const m = raw.match(/[A-Ea-e]/);
    return m ? m[0].toUpperCase() : null;
  },

  /**
   * Returns: { stem: string, options: {A,B,C,D,...}, answerLine: string|null }
   */
  parse(lines) {
    const stem = [];
    const options = {};
    let answerLine = null;
    let currentOptKey = null;
    let currentOptText = [];
    let inOptions = false;

    const flush = () => {
      if (currentOptKey && currentOptText.length) {
        options[currentOptKey] = currentOptText.join(' ').trim();
        currentOptKey = null;
        currentOptText = [];
      }
    };

    // Lines that signal explanation prose has started — stop parsing options
    const EXPL = [
      /^ans(wer)?\s*[:\-]?\s*$/i,            // bare 'Ans:' line
      /^thus\s+\(/i,                           // 'Thus (b) is correct'
      /^the\s+(correct\s+)?answer\s+is/i,      // 'The answer is B'
      /^(in|the|a|an)\s+[a-z].{40,}/,          // long lowercase prose (≥40 chars)
      /^(it|this|these|they)\s+(is|are|provide|help|contain|secrete|play)/i,
    ];
    const isExpl = l => EXPL.some(r => r.test(l));
    let done = false;

    for (const line of lines) {
      if (done) break;

      // 'Ans: B' or 'Ans: (b)' — capture letter and stop
      const ansInline = line.match(/^ans(wer)?\s*[:\-]?\s*[\(\[]?([A-Da-d])[\)\]]?\s*\.?\s*$/i);
      if (ansInline) {
        answerLine = ansInline[2].toUpperCase();
        flush(); done = true; continue;
      }

      // bare 'Ans:' with no letter — explanation text follows, stop
      if (/^ans(wer)?\s*[:\-]?\s*$/i.test(line)) { flush(); done = true; continue; }

      // Explanation prose after options started — stop
      if (inOptions && isExpl(line)) { flush(); done = true; continue; }

      // Check if this line starts a new option
      const optMatch = line.match(/^[\(\[]?([A-Da-d])[\.\)\]:\-]\s*(.*)/i);

      if (optMatch && BlockDetector.isOptionStart(line)) {
        flush();
        inOptions = true;
        currentOptKey = optMatch[1].toUpperCase();
        currentOptText = [optMatch[2].trim()];
      } else if (inOptions && currentOptKey) {
        if (BlockDetector.isOptionStart(line)) {
          flush();
          const m2 = line.match(/^[\(\[]?([A-Da-d])[\.\)\]:\-]\s*(.*)/i);
          if (m2) { currentOptKey = m2[1].toUpperCase(); currentOptText = [m2[2].trim()]; }
        } else if (BlockDetector.isQuestionStart(line) || isExpl(line)) {
          flush(); done = true;
        } else {
          currentOptText.push(line);
        }
      } else if (!inOptions) {
        if (!isExpl(line)) stem.push(line);
      }
    }
    flush();

    return {
      stem: stem.join(' ').replace(/\s+/g, ' ').trim(),
      options,
      answerLine
    };
  }
};

/* ═══════════════════════════════════════════════════════════════════
   5. QUESTION PARSER
   Assembles structured MCQ from a block.
   ═══════════════════════════════════════════════════════════════════ */
const QuestionParser = {
  /**
   * Strip question numbering prefix from stem
   * "1. What is..." → "What is..."
   */
  cleanStem(raw) {
    return raw
      .replace(/^Q\.?\s*\d+[.):\s]+/i, '')
      .replace(/^\d{1,3}[.)]\s+/, '')
      .replace(/^\(\s*\d{1,3}\s*\)\s*/, '')
      .replace(/^Question\s+\d+[.):\s]*/i, '')
      .trim();
  },

  parse(block) {
    const { lines, page } = block;
    const { stem, options, answerLine } = OptionReconstructor.parse(lines);

    const cleanedStem = this.cleanStem(stem);
    const q = {
      question: cleanedStem,
      options: {
        A: options.A || null,
        B: options.B || null,
        C: options.C || null,
        D: options.D || null,
      },
      answer: answerLine,
      metadata: { page, confidence: 1.0 },
      needsReview: false
    };

    // Include E if present
    if (options.E) q.options.E = options.E;

    return q;
  }
};

/* ═══════════════════════════════════════════════════════════════════
   6. VALIDATION SYSTEM
   ═══════════════════════════════════════════════════════════════════ */
const ValidationSystem = {
  validate(q) {
    let confidence = 1.0;
    const issues = [];

    if (!q.question || q.question.length < 8) {
      confidence -= 0.4;
      issues.push('very short or missing question stem');
    }

    const optCount = Object.values(q.options).filter(Boolean).length;
    if (optCount < 2) {
      confidence -= 0.5;
      issues.push(`only ${optCount} options found`);
    } else if (optCount === 3) {
      confidence -= 0.1; // mild — CBSE sometimes has 3 visible options after cleanup
      issues.push('only 3 of 4 options found');
    }
    // 4 options = no penalty

    if (!q.answer) {
      confidence -= 0.1;
      issues.push('no answer key detected');
    }

    // Suspiciously short options
    const shortOpts = Object.values(q.options).filter(v => v && v.length < 2).length;
    if (shortOpts > 0) {
      confidence -= 0.15 * shortOpts;
      issues.push(`${shortOpts} very short option(s)`);
    }

    q.metadata.confidence = Math.max(0, Math.min(1, confidence));
    q.metadata.issues = issues;
    q.needsReview = q.metadata.confidence < 0.65;

    return q;
  }
};


/* ═══════════════════════════════════════════════════════════════════
   AI EXTRACTOR
   ═══════════════════════════════════════════════════════════════════ */
const AIExtractor = {
  keys: { claude: null, openrouter: null, grok: null },
  available: [],
  _robin: 0,
  _lastLog: '',

  init(keys) {
    this.keys = keys;
    this.available = [];
    if (keys.claude)     this.available.push('claude');
    if (keys.openrouter) this.available.push('openrouter');
    if (keys.grok)       this.available.push('grok');
  },

  PROMPT(text) {
    return `Extract every MCQ question from the text below. The PDF may be two-column so text may be interleaved. Use question numbers to sort correctly.
Return ONLY a valid JSON array, no markdown, no explanation:
[{"n":1,"q":"question stem","a":"option a text","b":"option b text","c":"option c text","d":"option d text","ans":"b"}]
Rules:
- "n" = question number (integer)
- "q" = question stem only, no numbering prefix
- "a"-"d" = option text only, no letter prefix
- "ans" = correct letter (a/b/c/d) if determinable, else null
- Omit questions with fewer than 2 options or no discernible stem
TEXT:
${text}`;
  },

  async callClaude(text) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.keys.claude,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{ role: 'user', content: this.PROMPT(text) }]
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d.content[0].text;
  },

  async callOpenRouter(text) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.keys.openrouter}`
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.3-70b-instruct:free',
        max_tokens: 4096,
        messages: [{ role: 'user', content: this.PROMPT(text) }]
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
    return d.choices[0].message.content;
  },

  async callGrok(text) {
    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.keys.grok}`
      },
      body: JSON.stringify({
        model: 'grok-3-mini',
        max_tokens: 4096,
        messages: [{ role: 'user', content: this.PROMPT(text) }]
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
    return d.choices[0].message.content;
  },

  parseJSON(raw) {
    const clean = raw.replace(/```json|```/gi, '').trim();
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try { return JSON.parse(match[0]); } catch(e) { return []; }
  },

  async extractChunk(text) {
    for (let i = 0; i < this.available.length; i++) {
      const api = this.available[(this._robin + i) % this.available.length];
      try {
        let raw;
        if (api === 'claude')     raw = await this.callClaude(text);
        if (api === 'openrouter') raw = await this.callOpenRouter(text);
        if (api === 'grok')       raw = await this.callGrok(text);
        this._robin++;
        const parsed = this.parseJSON(raw);
        this._lastLog = '[' + api + '] got ' + parsed.length + ' items';
        return parsed;
      } catch(e) {
        this._lastLog = '[' + api + '] ERROR: ' + e.message;
      }
    }
    return [];
  },

  toMCQ(item, page) {
    const q = {
      question: (item.q || '').trim(),
      options: {
        A: item.a || null,
        B: item.b || null,
        C: item.c || null,
        D: item.d || null,
      },
      answer: item.ans ? item.ans.toUpperCase() : null,
      metadata: { page, confidence: 1.0, issues: [], n: item.n || 0 },
      needsReview: false
    };
    ValidationSystem.validate(q);
    return q;
  }
};

/* ═══════════════════════════════════════════════════════════════════
   MAIN PIPELINE
   ═══════════════════════════════════════════════════════════════════ */
async function runPipeline(files, onLog, onProgress) {
  const allPages = [];
  let totalPages = 0, donePages = 0;

  for (const file of files) {
    onLog(`📄 Loading: ${file.name}`);
    const buf = await file.arrayBuffer();
    const pages = await PDFExtractor.extract(buf, (cur, total) => {
      donePages++;
      totalPages = Math.max(totalPages, total * files.length);
      onProgress(Math.round((donePages / Math.max(totalPages, 1)) * 30), `Reading page ${cur}/${total}`);
    });
    onLog(`✓ Extracted ${pages.length} pages`, 'ok');
    pages.forEach(p => allPages.push({ ...p, fileName: file.name }));
  }

  const PAGES_PER_CHUNK = 8;
  const chunks = [];
  for (let i = 0; i < allPages.length; i += PAGES_PER_CHUNK)
    chunks.push(allPages.slice(i, i + PAGES_PER_CHUNK));

  onLog(`🤖 Sending ${chunks.length} chunks to AI (${AIExtractor.available.join(', ')})…`);
  onProgress(32, `Processing ${chunks.length} chunks via AI…`);

  const PARALLEL = Math.max(1, AIExtractor.available.length);
  const allItems = [];

  for (let i = 0; i < chunks.length; i += PARALLEL) {
    const batch = chunks.slice(i, i + PARALLEL);
    const results = await Promise.all(batch.map(async chunk => {
      const text = chunk.map(p => p.text).join('\n');
      const items = await AIExtractor.extractChunk(text);
      return items.map(item => ({ ...item, _page: chunk[0].page }));
    }));
    results.forEach(r => r.forEach(it => allItems.push(it)));
    const pct = 32 + Math.round(((i + PARALLEL) / chunks.length) * 58);
    onProgress(Math.min(90, pct), `AI processed ${Math.min(i + PARALLEL, chunks.length)}/${chunks.length} chunks`);
    await sleep(20);
  }

  onLog(`✓ AI returned ${allItems.length} raw items`, 'ok');
  if (AIExtractor._lastLog) onLog(`🔍 ${AIExtractor._lastLog}`, allItems.length ? 'ok' : 'warn');
  onProgress(92, 'Sorting and deduplicating…');

  allItems.sort((a, b) => (a.n || 0) - (b.n || 0));
  const seen = new Set();
  const questions = [];
  for (const item of allItems) {
    if (!item.q || item.q.length < 5) continue;
    const key = `${item.n}:${item.q.slice(0, 30)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push(AIExtractor.toMCQ(item, item._page || 0));
  }

  onLog(`✓ Structured ${questions.length} questions`, 'ok');
  const flagged = questions.filter(q => q.needsReview).length;
  if (flagged) onLog(`⚠ ${flagged} flagged for review`, 'warn');

  onProgress(100, 'Done!');
  return questions;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ═══════════════════════════════════════════════════════════════════
   STORAGE  (IndexedDB wrapper)
   ═══════════════════════════════════════════════════════════════════ */
const Storage = {
  DB_NAME: 'examforge',
  DB_VER: 1,
  STORE: 'banks',
  _db: null,

  async open() {
    if (this._db) return this._db;
    return new Promise((res, rej) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.STORE)) {
          const s = db.createObjectStore(this.STORE, { keyPath: 'id' });
          s.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = e => { this._db = e.target.result; res(this._db); };
      req.onerror = () => rej(req.error);
    });
  },

  async save(id, name, questions) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(this.STORE, 'readwrite');
      tx.objectStore(this.STORE).put({ id, name, questions, createdAt: Date.now() });
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },

  async load(id) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const req = db.transaction(this.STORE, 'readonly')
        .objectStore(this.STORE).get(id);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },

  async list() {
    const db = await this.open();
    return new Promise((res, rej) => {
      const req = db.transaction(this.STORE, 'readonly')
        .objectStore(this.STORE).getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },

  async delete(id) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(this.STORE, 'readwrite');
      tx.objectStore(this.STORE).delete(id);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }
};

/* ═══════════════════════════════════════════════════════════════════
   QUIZ ENGINE
   ═══════════════════════════════════════════════════════════════════ */
const QuizEngine = {
  state: null,

  init(questions, config) {
    let pool = [...questions];

    // Optionally skip low-confidence
    if (config.skipLow) {
      const filtered = pool.filter(q => q.metadata.confidence >= 0.65);
      // Fall back to full pool if filter removes everything
      pool = filtered.length ? filtered : pool;
    }

    // Shuffle questions
    if (config.shuffleQ) pool = shuffle(pool);

    // Limit count
    pool = pool.slice(0, config.count);

    // Shuffle options per question
    if (config.shuffleO) {
      pool = pool.map(q => {
        const keys = Object.keys(q.options).filter(k => q.options[k]);
        const vals = keys.map(k => q.options[k]);
        shuffleInPlace(vals);
        const newOpts = {};
        keys.forEach((k, i) => { newOpts[k] = vals[i]; });

        // Remap answer if shuffled
        let newAnswer = null;
        if (q.answer) {
          const oldVal = q.options[q.answer];
          const newKey = keys.find(k => newOpts[k] === oldVal);
          newAnswer = newKey || null;
        }
        return { ...q, options: newOpts, answer: newAnswer };
      });
    }

    this.state = {
      questions: pool,
      current: 0,
      answers: Array(pool.length).fill(null), // null | key | 'skipped'
      startTime: Date.now(),
      config,
      timerInterval: null
    };

    return this.state;
  },

  currentQuestion() {
    const { questions, current } = this.state;
    return questions[current] || null;
  },

  answer(key) {
    const s = this.state;
    if (s.answers[s.current] !== null) return;
    s.answers[s.current] = key;
  },

  skip() {
    const s = this.state;
    if (s.answers[s.current] === null) s.answers[s.current] = 'skipped';
  },

  next() {
    const s = this.state;
    if (s.current < s.questions.length - 1) {
      s.current++;
      return true;
    }
    return false;
  },

  isAnswered() {
    return this.state.answers[this.state.current] !== null;
  },

  results() {
    const { questions, answers } = this.state;
    let correct = 0, wrong = 0, skipped = 0;

    const detail = questions.map((q, i) => {
      const given = answers[i];
      const expected = q.answer;
      let status;
      if (given === 'skipped' || given === null) { skipped++; status = 'skipped'; }
      else if (!expected) { status = 'no-answer'; skipped++; }
      else if (given === expected) { correct++; status = 'correct'; }
      else { wrong++; status = 'wrong'; }
      return { q, given, expected, status };
    });

    return { correct, wrong, skipped, total: questions.length, detail };
  }
};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/* ═══════════════════════════════════════════════════════════════════
   UI CONTROLLER
   ═══════════════════════════════════════════════════════════════════ */
const UI = {
  /* Active screen */
  currentScreen: 'upload',

  /* App state */
  pendingFiles: [],
  questions: [],
  activeBank: null,
  quizConfig: { mode: 'practice', count: 20, timeLimit: 30, shuffleQ: true, shuffleO: true, skipLow: false },
  timerInterval: null,
  resultsData: null,

  /* ── Init ─────────────────────────────────────────────────────── */
  async init() {
    this.bindUpload();
    this.bindConfigure();
    this.bindQuiz();
    this.bindResults();
    this.bindReview();
    await this.loadLibrary();
  },

  /* ── Screen navigation ───────────────────────────────────────── */
  showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(`screen-${id}`).classList.add('active');
    this.currentScreen = id;
    window.scrollTo(0, 0);
  },

  /* ══════════════════════════════════════════════════════════════
     UPLOAD SCREEN
     ══════════════════════════════════════════════════════════════ */
  bindUpload() {
    const zone = document.getElementById('upload-zone');
    const input = document.getElementById('file-input');
    const browseBtn = document.getElementById('browse-btn');
    const processBtn = document.getElementById('process-btn');
    const clearBtn = document.getElementById('clear-btn');

    browseBtn.addEventListener('click', () => input.click());
    zone.addEventListener('click', e => { if (e.target === zone || e.target.closest('.upload-icon')) input.click(); });
    input.addEventListener('change', () => this.addFiles(Array.from(input.files)));

    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      this.addFiles(Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf'));
    });

    processBtn.addEventListener('click', () => this.startProcessing());
    clearBtn.addEventListener('click', () => this.clearFiles());
  },

  addFiles(files) {
    const pdfs = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
    const existing = new Set(this.pendingFiles.map(f => f.name));
    const newFiles = pdfs.filter(f => !existing.has(f.name));
    this.pendingFiles.push(...newFiles);
    this.renderFileList();
  },

  renderFileList() {
    const list = document.getElementById('file-list');
    const actions = document.getElementById('upload-actions');
    list.innerHTML = '';

    this.pendingFiles.forEach((f, i) => {
      const item = document.createElement('div');
      item.className = 'file-item';
      item.innerHTML = `
        <span class="file-icon">📄</span>
        <span class="file-name">${escHtml(f.name)}</span>
        <span class="file-size">${formatBytes(f.size)}</span>
        <button class="file-remove" data-i="${i}" title="Remove">✕</button>
      `;
      list.appendChild(item);
    });

    list.querySelectorAll('.file-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        this.pendingFiles.splice(parseInt(btn.dataset.i), 1);
        this.renderFileList();
      });
    });

    actions.style.display = this.pendingFiles.length ? 'flex' : 'none';
  },

  clearFiles() {
    this.pendingFiles = [];
    document.getElementById('file-input').value = '';
    this.renderFileList();
  },

  /* ── Library ─────────────────────────────────────────────────── */
  async loadLibrary() {
    const banks = await Storage.list();
    const section = document.getElementById('library-section');
    const grid = document.getElementById('library-grid');
    grid.innerHTML = '';

    if (!banks.length) { section.style.display = 'none'; return; }
    section.style.display = 'block';

    banks.sort((a, b) => b.createdAt - a.createdAt).forEach(bank => {
      const item = document.createElement('div');
      item.className = 'lib-item';
      item.innerHTML = `
        <div class="lib-info">
          <div class="lib-name">${escHtml(bank.name)}</div>
          <div class="lib-meta">${bank.questions.length} questions · ${timeAgo(bank.createdAt)}</div>
        </div>
        <button class="lib-delete" data-id="${bank.id}" title="Delete">🗑</button>
      `;
      item.addEventListener('click', e => {
        if (!e.target.closest('.lib-delete')) this.loadBank(bank);
      });
      item.querySelector('.lib-delete').addEventListener('click', async e => {
        e.stopPropagation();
        await Storage.delete(bank.id);
        await this.loadLibrary();
      });
      grid.appendChild(item);
    });
  },

  async loadBank(bank) {
    this.questions = bank.questions;
    this.activeBank = bank;
    this.showConfigure();
  },

  /* ══════════════════════════════════════════════════════════════
     PROCESSING
     ══════════════════════════════════════════════════════════════ */
  promptAPIKeys() {
    return new Promise(resolve => {
      document.getElementById('key-modal')?.remove();
      const modal = document.createElement('div');
      modal.id = 'key-modal';
      Object.assign(modal.style, {
        position:'fixed', inset:'0', background:'rgba(0,0,0,.75)', zIndex:'9999',
        display:'flex', alignItems:'center', justifyContent:'center', padding:'1rem'
      });
      const box = document.createElement('div');
      Object.assign(box.style, {
        background:'#111827', border:'1px solid rgba(255,255,255,.1)', borderRadius:'16px',
        padding:'2rem', maxWidth:'420px', width:'100%', display:'flex',
        flexDirection:'column', gap:'1rem'
      });
      const h2 = document.createElement('h2');
      h2.textContent = '🤖 AI Extraction Keys';
      Object.assign(h2.style, { fontFamily:'sans-serif', fontSize:'1.1rem', fontWeight:'800', margin:'0', color:'#f0f4ff' });
      const p = document.createElement('p');
      p.textContent = 'Enter at least one key. Keys stay in memory only — never stored.';
      Object.assign(p.style, { fontSize:'.82rem', color:'#a8b4cc', lineHeight:'1.5', margin:'0' });
      box.appendChild(h2);
      box.appendChild(p);
      const inputs = {};
      [['claude','Claude API key (console.anthropic.com)'],
       ['openrouter','OpenRouter key — FREE (openrouter.ai)'],
       ['grok','Grok key (console.x.ai)']
      ].forEach(([key, label]) => {
        const wrap = document.createElement('div');
        Object.assign(wrap.style, { display:'flex', flexDirection:'column', gap:'.3rem' });
        const lbl = document.createElement('label');
        lbl.textContent = label;
        Object.assign(lbl.style, { fontSize:'.75rem', color:'#5b6a85', textTransform:'uppercase', letterSpacing:'.05em' });
        const inp = document.createElement('input');
        inp.type = 'password';
        inp.placeholder = 'Paste key here…';
        Object.assign(inp.style, {
          background:'#1a2236', border:'1px solid rgba(255,255,255,.08)', borderRadius:'8px',
          padding:'.6rem .9rem', color:'#f0f4ff', fontFamily:'monospace', fontSize:'.8rem',
          width:'100%', boxSizing:'border-box'
        });
        inputs[key] = inp;
        wrap.appendChild(lbl);
        wrap.appendChild(inp);
        box.appendChild(wrap);
      });
      const row = document.createElement('div');
      Object.assign(row.style, { display:'flex', gap:'.75rem', marginTop:'.25rem' });
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      Object.assign(cancelBtn.style, {
        flex:'1', padding:'.7rem', borderRadius:'8px', border:'1px solid rgba(255,255,255,.1)',
        background:'none', color:'#a8b4cc', cursor:'pointer', fontSize:'.9rem'
      });
      const goBtn = document.createElement('button');
      goBtn.textContent = 'Extract with AI →';
      Object.assign(goBtn.style, {
        flex:'2', padding:'.7rem', borderRadius:'8px', border:'none',
        background:'#f5a623', color:'#0a0f1e', fontWeight:'700', cursor:'pointer', fontSize:'.9rem'
      });
      row.appendChild(cancelBtn);
      row.appendChild(goBtn);
      box.appendChild(row);
      modal.appendChild(box);
      document.body.appendChild(modal);
      goBtn.onclick = (e) => {
        e.stopPropagation();
        const keys = {
          claude:      inputs.claude.value.trim() || null,
          openrouter:  inputs.openrouter.value.trim() || null,
          grok:        inputs.grok.value.trim() || null
        };
        modal.remove();
        resolve(keys);
      };
      cancelBtn.onclick = (e) => { e.stopPropagation(); modal.remove(); resolve(null); };
    });
  },

  async startProcessing() {
    if (!this.pendingFiles.length) return;
    if (this._processing) return;
    this._processing = true;

    const keys = await this.promptAPIKeys();
    if (!keys) { this._processing = false; return; }
    AIExtractor.init(keys);
    if (!AIExtractor.available.length) {
      this._processing = false;
      alert('Please enter at least one API key.');
      return;
    }

    this.showScreen('processing');

    const ring = document.getElementById('ring-progress');
    const pct = document.getElementById('ring-pct');
    const title = document.getElementById('processing-title');
    const sub = document.getElementById('processing-sub');
    const log = document.getElementById('processing-log');
    const circumference = 276.46;

    const setProgress = (p, msg) => {
      ring.style.strokeDashoffset = circumference - (p / 100) * circumference;
      pct.textContent = p + '%';
      if (msg) sub.textContent = msg;
    };

    const addLog = (msg, cls = '') => {
      const line = document.createElement('div');
      line.className = 'log-line' + (cls ? ' ' + cls : '');
      line.textContent = msg;
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
    };

    const phases = ['Extracting text…', 'Normalizing…', 'Detecting blocks…', 'Structuring MCQs…'];
    let phaseIdx = 0;

    const updateTitle = () => { title.textContent = phases[phaseIdx] || 'Processing…'; };
    updateTitle();

    try {
      const questions = await runPipeline(
        this.pendingFiles,
        (msg, cls) => {
          addLog(msg, cls);
          phaseIdx = Math.min(phaseIdx + 1, phases.length - 1);
          updateTitle();
        },
        setProgress
      );

      this.questions = questions;

      // Save to IndexedDB
      const id = 'bank_' + Date.now();
      const name = this.pendingFiles.map(f => f.name.replace('.pdf', '')).join(', ');
      await Storage.save(id, name, questions);
      this.activeBank = { id, name };
      await this.loadLibrary();

      this.clearFiles();
      if (questions.length === 0) {
        title.textContent = '⚠ 0 questions extracted';
        sub.textContent = 'See log above. Check your API key and try again.';
        this._processing = false;
        return;
      }
      await sleep(800);
      this._processing = false;
      this.showConfigure();

    } catch (err) {
      addLog('✗ Error: ' + err.message, 'warn');
      title.textContent = 'Processing failed';
      sub.textContent = 'Check the log above for details.';
      this._processing = false;
    }
  },

  /* ══════════════════════════════════════════════════════════════
     CONFIGURE SCREEN
     ══════════════════════════════════════════════════════════════ */
  showConfigure() {
    this.showScreen('configure');

    const qs = this.questions;
    const good = qs.filter(q => !q.needsReview);
    const flagged = qs.filter(q => q.needsReview);
    const answered = qs.filter(q => q.answer);
    const avgConf = qs.length
      ? Math.round(qs.reduce((s, q) => s + q.metadata.confidence, 0) / qs.length * 100)
      : 0;

    document.getElementById('cfg-stats').innerHTML = `
      <div class="stat-pill"><span class="stat-num">${qs.length}</span><span class="stat-lbl">Total questions</span></div>
      <div class="stat-pill"><span class="stat-num">${good.length}</span><span class="stat-lbl">High quality</span></div>
      <div class="stat-pill"><span class="stat-num">${answered.length}</span><span class="stat-lbl">With answers</span></div>
      <div class="stat-pill"><span class="stat-num">${avgConf}%</span><span class="stat-lbl">Avg confidence</span></div>
    `;

    const reviewBanner = document.getElementById('review-banner');
    if (flagged.length) {
      reviewBanner.style.display = 'flex';
      document.getElementById('review-count-msg').textContent =
        `${flagged.length} question${flagged.length > 1 ? 's' : ''} flagged for review.`;
    } else {
      reviewBanner.style.display = 'none';
    }

    const qCount = document.getElementById('q-count');
    const qCountVal = document.getElementById('q-count-val');
    qCount.max = qs.length;
    qCount.value = Math.min(20, qs.length);
    qCountVal.textContent = qCount.value;
    document.getElementById('q-available').textContent = qs.length;
    this.quizConfig.count = parseInt(qCount.value);

    qCount.oninput = () => {
      qCountVal.textContent = qCount.value;
      this.quizConfig.count = parseInt(qCount.value);
    };

    const timeLimit = document.getElementById('time-limit');
    const timeLimitVal = document.getElementById('time-limit-val');
    timeLimit.oninput = () => {
      timeLimitVal.textContent = timeLimit.value + ' min';
      this.quizConfig.timeLimit = parseInt(timeLimit.value);
    };

    document.getElementById('shuffle-q').onchange = e => { this.quizConfig.shuffleQ = e.target.checked; };
    document.getElementById('shuffle-o').onchange = e => { this.quizConfig.shuffleO = e.target.checked; };
    document.getElementById('skip-low').onchange  = e => { this.quizConfig.skipLow  = e.target.checked; };
  },

  bindConfigure() {
    document.getElementById('cfg-back-btn').addEventListener('click', () => this.showScreen('upload'));
    document.getElementById('goto-review-btn').addEventListener('click', () => this.showReview());
    document.getElementById('start-quiz-btn').addEventListener('click', () => this.startQuiz());

    const timerCard = document.getElementById('timer-card');
    const updateTimerCard = (mode) => {
      timerCard.style.opacity = mode === 'exam' ? '1' : '0.4';
      timerCard.style.pointerEvents = mode === 'exam' ? 'auto' : 'none';
    };
    updateTimerCard('practice'); // default

    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.quizConfig.mode = btn.dataset.mode;
        updateTimerCard(btn.dataset.mode);
      });
    });
  },

  /* ══════════════════════════════════════════════════════════════
     REVIEW SCREEN
     ══════════════════════════════════════════════════════════════ */
  showReview() {
    this.showScreen('review');
    const list = document.getElementById('review-list');
    list.innerHTML = '';

    const flagged = this.questions.filter(q => q.needsReview);
    if (!flagged.length) {
      list.innerHTML = '<p style="color:var(--text-2);font-size:.9rem;">No questions flagged. All looking good!</p>';
      return;
    }

    flagged.forEach((q, idx) => {
      const globalIdx = this.questions.indexOf(q);
      const conf = Math.round(q.metadata.confidence * 100);
      const confCls = conf >= 80 ? 'high' : conf >= 50 ? 'mid' : 'low';

      const card = document.createElement('div');
      card.className = 'rv-card';
      card.dataset.idx = globalIdx;

      const optHtml = Object.entries(q.options)
        .filter(([,v]) => v)
        .map(([k, v]) => `<div class="rv-opt"><span class="rv-opt-key">${k}.</span><span>${escHtml(v)}</span></div>`)
        .join('');

      card.innerHTML = `
        <div class="rv-card-head">
          <span class="rv-qnum">Question ${globalIdx + 1} · Page ${q.metadata.page}</span>
          <span class="rv-conf ${confCls}">Confidence: ${conf}% — ${(q.metadata.issues || []).join(', ')}</span>
        </div>
        <div class="rv-card-body">
          <div class="rv-q-text">${escHtml(q.question) || '<em style="color:var(--text-2)">No question stem detected</em>'}</div>
          <div class="rv-opts">${optHtml || '<em style="color:var(--text-2)">No options detected</em>'}</div>
        </div>
        <div class="rv-card-foot">
          <button class="btn btn-danger btn-sm" data-action="delete" data-idx="${globalIdx}">Remove question</button>
          <button class="btn btn-ghost btn-sm" data-action="keep" data-idx="${globalIdx}">Keep anyway</button>
        </div>
      `;
      list.appendChild(card);
    });

    list.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        if (btn.dataset.action === 'delete') {
          this.questions.splice(idx, 1);
          // Re-save to IDB
          if (this.activeBank) Storage.save(this.activeBank.id, this.activeBank.name, this.questions).catch(() => {});
          this.showReview();
        } else {
          this.questions[idx].needsReview = false;
          btn.closest('.rv-card').style.opacity = '0.4';
          btn.disabled = true;
        }
      });
    });
  },

  bindReview() {
    document.getElementById('rv-back-btn').addEventListener('click', () => this.showConfigure());
    document.getElementById('rv-done-btn').addEventListener('click', () => {
      this.showConfigure();
    });
  },

  /* ══════════════════════════════════════════════════════════════
     QUIZ SCREEN
     ══════════════════════════════════════════════════════════════ */
  startQuiz() {
    if (!this.questions.length) {
      alert('No questions available. Please upload a PDF first.');
      return;
    }

    const config = {
      mode: this.quizConfig.mode,
      count: Math.min(this.quizConfig.count, this.questions.length),
      timeLimit: this.quizConfig.timeLimit,
      shuffleQ: document.getElementById('shuffle-q').checked,
      shuffleO: document.getElementById('shuffle-o').checked,
      skipLow: document.getElementById('skip-low').checked
    };

    QuizEngine.init(this.questions, config);
    this.showScreen('quiz');
    this.renderQuestion();

    if (config.mode === 'exam') this.startTimer(config.timeLimit * 60);
  },

  renderQuestion() {
    const q = QuizEngine.currentQuestion();
    const s = QuizEngine.state;
    if (!q) { this.endQuiz(); return; }

    const total = s.questions.length;
    const current = s.current;

    // Progress
    document.getElementById('quiz-progress-fill').style.width = `${((current) / total) * 100}%`;
    document.getElementById('quiz-progress-txt').textContent = `${current + 1} / ${total}`;
    document.getElementById('q-number').textContent = `Q${current + 1}`;

    const conf = Math.round(q.metadata.confidence * 100);
    document.getElementById('q-confidence').textContent = conf < 80 ? `⚠ ${conf}% confidence` : '';

    document.getElementById('question-text').textContent = q.question;

    // Options
    const optList = document.getElementById('options-list');
    optList.innerHTML = '';
    Object.entries(q.options).filter(([,v]) => v).forEach(([key, val]) => {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.dataset.key = key;
      btn.innerHTML = `<span class="opt-key">${key}</span><span class="opt-text">${escHtml(val)}</span>`;
      btn.addEventListener('click', () => this.selectOption(key));
      optList.appendChild(btn);
    });

    // Reset feedback & next
    const fb = document.getElementById('feedback-box');
    fb.style.display = 'none';
    fb.className = 'feedback-box';

    document.getElementById('quiz-next-btn').disabled = true;
    document.getElementById('quiz-skip-btn').disabled = false;
  },

  selectOption(key) {
    if (QuizEngine.isAnswered()) return;
    QuizEngine.answer(key);

    const q = QuizEngine.currentQuestion();
    const mode = QuizEngine.state.config.mode;

    document.querySelectorAll('.option-btn').forEach(btn => {
      btn.disabled = true;
      if (btn.dataset.key === key) btn.classList.add('selected');
    });

    if (mode === 'practice') {
      this.showFeedback(key, q.answer);
    }

    document.getElementById('quiz-next-btn').disabled = false;
    document.getElementById('quiz-skip-btn').disabled = true;
  },

  showFeedback(given, expected) {
    const fb = document.getElementById('feedback-box');
    const inner = document.getElementById('feedback-inner');
    fb.style.display = 'block';

    if (!expected) {
      fb.className = 'feedback-box info';
      inner.textContent = 'No answer key available for this question.';
    } else if (given === expected) {
      fb.className = 'feedback-box correct';
      inner.textContent = '✓ Correct!';
      document.querySelector(`.option-btn[data-key="${given}"]`)?.classList.add('correct');
    } else {
      fb.className = 'feedback-box wrong';
      inner.textContent = `✗ Incorrect. The correct answer is ${expected}.`;
      document.querySelector(`.option-btn[data-key="${given}"]`)?.classList.add('wrong');
      document.querySelector(`.option-btn[data-key="${expected}"]`)?.classList.add('reveal');
    }
  },

  bindQuiz() {
    document.getElementById('quiz-next-btn').addEventListener('click', () => {
      if (!QuizEngine.isAnswered()) return;
      const hasMore = QuizEngine.next();
      if (hasMore) this.renderQuestion();
      else this.endQuiz();
    });

    document.getElementById('quiz-skip-btn').addEventListener('click', () => {
      QuizEngine.skip();
      document.getElementById('quiz-next-btn').disabled = false;
      document.getElementById('quiz-skip-btn').disabled = true;
      document.querySelectorAll('.option-btn').forEach(b => b.disabled = true);
    });
  },

  startTimer(totalSeconds) {
    const timerEl = document.getElementById('quiz-timer');
    const displayEl = document.getElementById('timer-display');
    timerEl.style.display = 'flex';
    timerEl.classList.remove('urgent');

    let remaining = totalSeconds;

    const format = s => {
      const m = Math.floor(s / 60).toString().padStart(2, '0');
      const sec = (s % 60).toString().padStart(2, '0');
      return `${m}:${sec}`;
    };

    displayEl.textContent = format(remaining);

    this.timerInterval = setInterval(() => {
      remaining--;
      displayEl.textContent = format(remaining);
      if (remaining <= 60) timerEl.classList.add('urgent');
      if (remaining <= 0) {
        clearInterval(this.timerInterval);
        this.endQuiz();
      }
    }, 1000);
  },

  endQuiz() {
    if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
    this.resultsData = QuizEngine.results();
    this.showResults();
  },

  /* ══════════════════════════════════════════════════════════════
     RESULTS SCREEN
     ══════════════════════════════════════════════════════════════ */
  showResults() {
    this.showScreen('results');
    const { correct, wrong, skipped, total, detail } = this.resultsData;
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;

    // Score ring
    const circumference = 439.82;
    setTimeout(() => {
      document.getElementById('score-ring-fill').style.strokeDashoffset =
        circumference - (pct / 100) * circumference;
    }, 100);
    document.getElementById('score-pct').textContent = pct + '%';

    // Breakdown
    document.getElementById('score-breakdown').innerHTML = `
      <div class="score-row"><span>Correct</span><span class="score-row-val ok">${correct}</span></div>
      <div class="score-row"><span>Incorrect</span><span class="score-row-val err">${wrong}</span></div>
      <div class="score-row"><span>Skipped / No key</span><span class="score-row-val dim">${skipped}</span></div>
      <div class="score-row"><span>Total</span><span class="score-row-val">${total}</span></div>
    `;

    this.renderResultsList('wrong', detail);
  },

  renderResultsList(tab, detail) {
    const list = document.getElementById('results-list');
    list.innerHTML = '';

    const items = tab === 'wrong'
      ? detail.filter(d => d.status === 'wrong' || d.status === 'skipped')
      : detail;

    if (!items.length) {
      list.innerHTML = '<p style="color:var(--text-2);font-size:.9rem;">Nothing to show here.</p>';
      return;
    }

    items.forEach(({ q, given, expected, status }) => {
      const card = document.createElement('div');
      card.className = `result-card ${status === 'correct' ? 'correct' : status === 'wrong' ? 'wrong' : 'skipped'}`;

      const statusLabel = status === 'correct' ? '✓ Correct' : status === 'wrong' ? '✗ Incorrect' : 'Skipped';
      const statusCls   = status === 'correct' ? 'ok' : status === 'wrong' ? 'err' : 'dim';

      const answerHtml = status === 'wrong' ? `
        <div class="result-answers">
          <div class="result-your-ans">Your answer: ${given ? `${given}. ${escHtml(q.options[given] || '')}` : '—'}</div>
          ${expected ? `<div class="result-correct-ans">Correct: ${expected}. ${escHtml(q.options[expected] || '')}</div>` : ''}
        </div>` : status === 'correct' ? `
        <div class="result-answers">
          <div class="result-your-ans ok">✓ ${given}. ${escHtml(q.options[given] || '')}</div>
        </div>` : '';

      card.innerHTML = `
        <div class="result-card-head">
          <span class="result-status ${statusCls}">${statusLabel}</span>
          <span style="font-family:var(--font-mono);font-size:.72rem;color:var(--text-2)">Page ${q.metadata.page}</span>
        </div>
        <div class="result-card-body">
          <div class="result-q">${escHtml(q.question)}</div>
          ${answerHtml}
        </div>
      `;
      list.appendChild(card);
    });
  },

  bindResults() {
    document.getElementById('res-home-btn').addEventListener('click', () => this.showScreen('upload'));

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.renderResultsList(btn.dataset.tab, this.resultsData.detail);
      });
    });

    document.getElementById('retry-btn').addEventListener('click', () => {
      this.startQuiz();
    });

    document.getElementById('new-quiz-btn').addEventListener('click', () => {
      this.showScreen('upload');
    });
  }
};

/* ─── Helpers ────────────────────────────────────────────────────── */
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

/* ─── Boot ───────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => UI.init());
