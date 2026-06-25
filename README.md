# ExamForge — PDF → MCQ Quiz Engine

A fully browser-based exam preparation system. No backend, no frameworks, no install.  
Drop messy exam PDFs in. Get a structured, timed quiz out.

---

## Files

```
index.html   — All screens / markup
style.css    — Design system + responsive layout
app.js       — Full pipeline + quiz engine (~1200 lines)
```

Open `index.html` directly in any modern browser. No server required.

---

## Architecture

### Pipeline (runs entirely in-browser)

```
PDF file(s)
    │
    ▼
┌─────────────────────────────────┐
│  1. PDFExtractor                │  pdf.js (CDN)
│     • Loads ArrayBuffer         │  Extracts text items per page
│     • Groups items into lines   │  Position-aware Y-axis sort
│     • Returns [{page, text}]    │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  2. TextNormalizer              │
│     • Fixes hyphenated breaks   │  "infor-\nmation" → "information"
│     • Strips page numbers       │  "Page 12", lone "12" lines
│     • Strips ALL-CAPS headers   │  Heuristic, preserves numbered lines
│     • Normalises unicode dashes │  em/en → hyphen
│     • Collapses blank lines     │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  3. BlockDetector               │
│     • Scans line-by-line        │
│     • 6 question-start patterns │  Q1. / 1. / (1) / Question 1 …
│     • Groups lines into blocks  │  Each block = one raw question
│     • Preserves page number     │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  4. OptionReconstructor         │
│     • Detects option lines      │  A. / A) / (A) / A: patterns
│     • Handles multi-line opts   │  Continuation until next opt/Q
│     • Extracts embedded answers │  "Answer: B" / "Ans: C" lines
│     • Returns {stem, options{}} │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  5. QuestionParser              │
│     • Strips numbering prefix   │  "1. What…" → "What…"
│     • Assembles MCQ object      │  {question, options{A-E}, answer}
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  6. ValidationSystem            │
│     • Scores confidence 0–1.0   │
│     • Deductions:               │
│         stem < 8 chars  −0.40   │
│         < 2 options     −0.50   │
│         < 4 options     −0.20   │
│         no answer key   −0.10   │
│         short options   −0.15ea │
│     • needsReview = conf < 0.65 │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  Storage (IndexedDB)            │
│     • Auto-saves parsed banks   │
│     • Persists across sessions  │
│     • Load previous PDFs        │
└─────────────────────────────────┘
```

### Quiz Engine (state machine)

```
init(questions, config)
  → applies skipLow filter
  → shuffles questions (Fisher-Yates)
  → shuffles options (remaps answer key)
  → builds answers[] array

answer(key)  →  records selection (immutable once set)
skip()       →  marks 'skipped'
next()       →  advances cursor, returns false at end
results()    →  {correct, wrong, skipped, total, detail[]}
```

---

## MCQ Object Schema

```json
{
  "question": "Which of the following is NOT a primary colour?",
  "options": {
    "A": "Red",
    "B": "Blue",
    "C": "Green",
    "D": "Yellow"
  },
  "answer": "C",
  "metadata": {
    "page": 4,
    "confidence": 0.95,
    "issues": []
  },
  "needsReview": false
}
```

---

## Supported Question Formats

| Format | Example |
|--------|---------|
| Numbered dot | `1. What is...` |
| Numbered paren | `1) What is...` |
| Q-prefix | `Q1. What is...` / `Q.1` |
| Question word | `Question 1:` |
| Parenthesised num | `(1) What is...` |

| Option Format | Example |
|---------------|---------|
| Letter dot | `A. Option text` |
| Letter paren | `A) Option text` |
| Parens letter | `(A) Option text` |
| Letter colon | `A: Option text` |
| Letter dash | `A - Option text` |

| Answer Key Format | Example |
|-------------------|---------|
| Answer colon | `Answer: B` |
| Ans colon | `Ans: B` |
| Correct answer | `Correct Answer: C` |

---

## Edge Cases Handled

| Problem | Strategy |
|---------|----------|
| Options split across lines | Continuation accumulator until next option-start or question-start |
| Questions split across pages | BlockDetector works on all pages joined; page metadata from block start |
| Mixed numbering styles | 6 regex patterns, any match triggers new block |
| Header/footer noise | Heuristic strip: lone numbers, ALL-CAPS short lines, "Page N" |
| Hyphenated line breaks | `word-\nnext` → `wordnext` pre-normalization |
| No answer key in PDF | `answer: null`, shown as "No answer key" in practice feedback |
| Low-confidence questions | Flagged → Review Queue before quiz |
| Large PDFs / UI freeze | Async page-by-page extraction + chunked parsing (20 blocks/tick) |
| Options E / 5-choice | Automatically included if detected |
| Roman numeral options | Detected but mapped to standard A/B/C/D keys |

---

## Modes

**Practice mode** — After each answer, immediate feedback: ✓ correct / ✗ wrong with correct answer revealed.

**Exam mode** — No feedback until end. Countdown timer. Full score review at the end.

---

## Browser Compatibility

Requires: Chrome 90+, Firefox 88+, Safari 15+, Edge 90+  
Uses: `IndexedDB`, `ArrayBuffer`, `pdf.js`, `CSS custom properties`, `dvh` units
