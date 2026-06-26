# 📚 QP-QUIZZER

Turn any exam PDF into a live quiz — instantly, in your browser.

Built for CBSE students who want to practice from question papers without manually typing out questions.

---

## ✨ Features

- 📄 Upload any MCQ-based exam PDF
- 🤖 AI extracts all questions automatically
- ⚡ Supports up to 20 parallel API keys for blazing fast extraction
- 🎯 Practice mode — instant feedback after each answer
- 📝 Exam mode — full test experience with timer
- 🔀 Shuffle questions and options
- 📊 Detailed results with score breakdown
- 💾 Saves question banks locally — no re-upload needed
- 🔒 100% in-browser — your PDFs and keys never leave your device

---

## 🚀 How to Use

### Step 1 — Get a Free API Key
1. Go to [openrouter.ai](https://openrouter.ai)
2. Sign up (free, no credit card)
3. Go to **Keys** → **Create key**
4. Copy your `sk-or-...` key
5. Create up to 20 keys for faster extraction

### Step 2 — Upload & Extract
1. Open the app
2. Drop your PDF onto the upload zone
3. Click **Extract & Build Quiz**
4. Paste your OpenRouter key(s) into the fields
5. Wait for extraction to complete

### Step 3 — Quiz Yourself
1. Choose Practice or Exam mode
2. Set number of questions
3. Hit **Start Quiz** and go!

---

## ⚡ Speed Tips

- More keys = faster extraction (parallel processing)
- Add one or more OpenRouter API keys to enable parallel extraction — each one processes a separate chunk simultaneously
- Smaller PDFs (under 50 pages) extract in under a minute with 5+ keys

---

## 🛠 Tech Stack

- Vanilla JS — no frameworks
- [PDF.js](https://mozilla.github.io/pdf.js/) for PDF parsing
- [OpenRouter](https://openrouter.ai) for AI extraction
- IndexedDB for local question bank storage
- GitHub Pages for hosting

---

## 📋 Supported PDF Types

Works best with:
- CBSE sample papers
- Previous year question papers
- NCERT exercise PDFs
- Any standard MCQ format

---

## 🔒 Privacy

No data is sent to any server except the OpenRouter API for question extraction. Your PDFs are processed entirely in your browser. API keys are stored in memory only and cleared when you close the tab.

---

Made with 😭🙏 and a lot of debugging.
