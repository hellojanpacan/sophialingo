# SophiaLingo — Single Source of Truth

> Read this at the start of every Claude Code session. It captures what the app is, who it's for, and what must never change.

---

## 1. Project Identity

**SophiaLingo** is a browser-based Spanish vocabulary trainer using the Leitner spaced repetition system.

- Built by Jan (developer) for Sophia (fiancée, primary user)
- Active daily use — features are iterated session by session via Claude Code
- May eventually expand to a broader audience, but today it serves one user

---

## 2. Users

| Role | Person | Relationship to app |
|------|--------|---------------------|
| Primary learner | Sophia | Uses the app daily to learn Spanish vocab |
| Developer / secondary user | Jan | Builds features, also uses the app |

**Sophia's learning context:** German is her native language. She is learning Spanish. The app tests her on Spanish words and she types the German translation.

---

## 3. Value Proposition

- **Frictionless daily review** — opens in a browser, no account, no install, no setup
- **Spaced repetition that actually works** — Leitner boxes ensure words surface at the right interval
- **Typo tolerance** — fuzzy matching means a near-miss doesn't feel like failure
- **Sentence context** — example sentences with word-by-word reveal help vocab stick beyond rote memorization
- **User-correctable data** — Sophia can fix wrong words mid-session via inline edit
- **Transparent data** — everything lives in a Google Sheet Jan controls and can inspect

---

## 4. Core UX Principles (Invariants)

These are deliberate product decisions. Do not change them without explicit instruction.

### 4.1 Leitner Box is the product
All word progression flows through the Leitner system. Box assignment, intervals, and reset-on-wrong are not implementation details — they are the core mechanic. Never bypass, abstract away, or replace the Leitner logic.

### 4.2 German UI always
Every label, button, message, and error text must stay in German. This is not just a preference — the UI language matching Sophia's native language is an intentional immersion choice. Examples: "Prüfen", "Weiter →", "Nächste Runde", "Wörter werden geladen…"

### 4.3 Speed over ceremony
Every step can be advanced with the Enter key. No unnecessary confirmation dialogs, modals, or multi-step flows. The quiz should feel fast.

### 4.4 Inline correction over interruption
When Sophia finds a wrong word, she can fix it without leaving the quiz flow. Edit buttons appear contextually — never require navigation to a separate edit screen.

### 4.5 Celebrate progress
Confetti fires on ≥70% accuracy. The summary screen uses emoji tiers. Progress dots are color-coded by result. Small moments of delight matter.

---

## 5. App Architecture

### Tech stack

| Layer | Choice | Constraint |
|-------|--------|------------|
| Frontend framework | React 18 + Vite | Plain JS/JSX — no TypeScript |
| UI styling | Inline CSS objects | No Tailwind, no CSS files, no UI component libraries |
| State management | React hooks only (`useState`, `useRef`) | No Zustand, Redux, or Context |
| Routing | None | Single SPA — phase-based conditional rendering |
| Font | DM Sans via Google Fonts CDN | |
| Backend | Google Apps Script | Permanent — no DB migration |
| Data store | Google Sheets | Permanent — no DB migration |

### Key files

| File | Purpose |
|------|---------|
| `src/SophiaLingo.jsx` | Monolithic main component (~900 lines) — all quiz logic + all UI |
| `src/main.jsx` | React entry point (10 lines) |
| `google-apps-script/Code.js` | Full backend — CRUD, Leitner logic, session logging (~500 lines) |
| `index.html` | HTML shell (`lang="de"`, Spanish flag favicon) |
| `vite.config.js` | Minimal Vite config |

### Architecture invariants

- Do **not** split `SophiaLingo.jsx` into subcomponents unless explicitly requested
- Do **not** introduce external UI or state management libraries
- Do **not** migrate to TypeScript
- Do **not** add routing or multi-page structure
- Do **not** migrate the backend away from Google Apps Script + Sheets

---

## 6. Backend & Data Architecture

### Backend

Google Apps Script deployed as a public web app. Jan deploys updates manually via the Apps Script editor. CORS is handled via `ContentService` JSON responses.

### Data store

Google Sheets — two sheets in one workbook:
- `SophiaLingo Database` — vocabulary words
- `Sessions` — quiz session logs

Sheet ID: `1t0itr36VJnfjW8-qKa8-pesjXoS_bqkKjtIpvrwmEIM`

### Word schema

```
word_id | source_lang | target_lang | source_word | target_word
leitner_box | next_review | last_reviewed | times_correct | times_wrong
date_added | source | example_sentence | sentence_eval
```

- `word_id` format: `"w_001"`
- `source_lang`: `"es"` (Spanish)
- `target_lang`: `"de"` (German)
- `sentence_eval`: `""` | `"up"` | `"down"`
- `source`: `"manual"` | `"photo"`

### Session schema

```
session_id | date | words_tested | correct | score_pct | completed
```

### Streak & Freeze

Streak state is **derived** by replaying the `Sessions` sheet — no schema change, no new sheet, no
server-side mutation. `getStreak` is read-only.

- **Streak day** = ≥1 completed round (one `logSession`) on a calendar day. `session_id` is
  `s_YYYYMMDD` (shared per day), so rounds-per-day = number of `Sessions` rows sharing a `date`.
- **Streak Freeze (earned)**: ≥3 rounds in a single day earns 1 freeze. Max 1 stored (no stacking).
  A freeze auto-covers exactly one missed day; a second consecutive miss breaks the streak.
- **Today is not over**: an unpracticed today never breaks the streak or consumes a freeze. The
  `frozen` flag is only surfaced when she has a covered gap *and* hasn't yet practiced today
  (`frozen && sessions_today === 0`); practicing today thaws it (🧊 → 🔥).
- **Day boundaries** use `Session.getScriptTimeZone()` (Europe/Vienna), consistent with all other
  date logic. The replay iterates day-by-day from a noon-anchored cursor to stay DST-safe.

`getStreak` returns: `{ streak, frozen, freezes, sessions_today, longest, emotion, today }`. The
`emotion` field is the canonical emoji (computed in `Code.js` so the notification cron consumes it
directly). The frontend mirrors the ladder in `emotionFor` (`SophiaLingo.jsx`) to project the
post-round emotion on the summary.

**Emotion ladder** (by streak length; `frozen` overrides with 🥶):

| Streak | 0 | 1 | 2–3 | 4–6 | 7–13 | 14–29 | 30–59 | 60–99 | 100+ |
|--------|---|---|-----|-----|------|-------|-------|-------|------|
| Emoji  | — | 😐 | 🙂 | 😊 | 🤠 | 😄 | 😆 | 🤩 | ⭐ |

### Streak notifications (Vercel Cron → Ntfy)

A serverless function `api/streak-reminder.js` (co-located in this repo, deployed with the app on
Vercel) runs daily via `vercel.json` cron. It reads `getStreak`, and — only if Sophia hasn't
practiced today (`sessions_today === 0`) — pushes a short Ntfy notification: urgent 🧊 warning when
`frozen`, normal 🔥 + count + emotion when the streak is intact, or a gentle nudge at streak 0.

- This is an **auxiliary notification sidecar** — it does **not** change the backend invariant
  (vocabulary/session data stays in Google Apps Script + Sheets). It is read-only against `getStreak`.
- Env vars (Vercel settings): `APPS_SCRIPT_URL`, `NTFY_TOPIC`, `CRON_SECRET`.
- Cron runs in **UTC, no DST**: `0 18 * * *` ≈ 19:00 Vienna (winter) / 20:00 (summer). Vercel Hobby
  allows one daily cron; a second (morning) ping needs Pro or an external scheduler.

### Leitner intervals (hardcoded in `Code.js`)

| From box | To box | Interval |
|----------|--------|----------|
| 1 | 2 | 1 day |
| 2 | 3 | 3 days |
| 3 | 4 | 7 days |
| 4 | 5 | 14 days |
| 5 | 5 | 30 days (mastered) |
| Any | 1 | tomorrow (wrong answer) |

### Word selection algorithm (`getWords` in `Code.js`)

Words are selected in two priority groups:

| Group | Condition | Sort within group |
|-------|-----------|-------------------|
| **A — active due** | `last_reviewed != ''` AND `next_review <= today` | `next_review ASC` (most overdue first), tiebreak `last_reviewed ASC` (oldest reviewed first — naturally favors higher-box words) |
| **B — new words** | `last_reviewed == ''` (never reviewed) | Sheet row order (oldest added first) |

Group A fills the batch first; Group B fills remaining slots. Excluded: active words with `next_review > today`.

`last_reviewed = ''` is the canonical signal for "never reviewed." New words added via `addWords` always start with an empty `last_reviewed`.

**Design intent:** "depth over breadth" — a word that graduates from box 1 to box 2 surfaces promptly when due, rather than waiting behind all box-1 words. Most-overdue words get priority; brand-new vocab is last until first review.

### API endpoints

**GET** (via `doGet`):

| Action | Purpose |
|--------|---------|
| `?action=getWords&limit=10` | Fetch today's due words |
| `?action=getStats` | Aggregate stats (box distribution, lifetime accuracy) |
| `?action=getStreak` | Current streak + freeze state (derived from Sessions) |
| `?action=ping` | Health check |

**POST** (via `doPost`, JSON body):

| Action | Payload | Purpose |
|--------|---------|---------|
| `updateWord` | `{word_id, correct: bool}` | Record answer, advance Leitner box |
| `editWord` | `{word_id, source_word?}` or `{word_id, target_word?}` | Inline word correction |
| `evalSentence` | `{word_id, eval: "up"\|"down"\|""}` | Save sentence rating |
| `logSession` | `{words_tested, correct}` | Record completed session |
| `addWords` | array of word pairs | Bulk insert new vocab |

---

## 7. App Flow (Phase State Machine)

```
loading
  ↓ (fetch words)
  ├─→ empty      (no words due today)
  ├─→ error      (API failure)
  └─→ quiz ──────────────────────────────────┐
        │                                     │
        │  For each word:                     │
        │  1. Word card: see Spanish word,    │
        │     type German translation         │
        │     (optional) "💡 Tipp" → hint      │
        │     sentence screen → tap to return  │
        │     and answer                       │
        │  2. Submit → fuzzy match runs       │
        │  3. Sentence reveal (if sentence    │
        │     exists): word-by-word animation │
        │     + 👍👎 rating buttons           │
        │  4. Feedback box: result + correct  │
        │     answer + inline edit buttons    │
        │  5. "Weiter →" / Enter → next word ─┘
        │
        ↓ (all words answered)
      summary
        ├─→ "Nächste Runde" → reload (more words due)
        └─→ done
```

### Session behavior

- Batch size: 10 words per round
- Progress dots: green (correct), orange (almost), red (incorrect), gray (pending)
- If total due > 10: shows "· N insgesamt fällig" counter
- Confetti at ≥70% accuracy
- Hint: on the word card (pre-answer), a "💡 Tipp" button appears when the word has ≥1 example sentence. It opens a hint sentence screen (same word-by-word reveal as the post-eval one, no 👍👎); tapping anywhere returns to the word card with the input refocused. The hint prefers a *different* sentence slot than the post-eval reveal (falls back to the same if only one exists). Using a hint has no scoring/Leitner effect and is not tracked. Frontend-only — uses sentence data already returned by `getWords`.
- Header: shows 🔥/🧊 + streak count + emotion emoji when streak ≥ 1 (replaces "Spanisch → Deutsch"); falls back to "Spanisch → Deutsch" at streak 0 or if `getStreak` fails. Flame has a subtle `flameFlicker` animation (not the frozen 🧊).
- Summary leads with the projected streak (🔥 + days + emotion) and a contextual freeze line; the score tier emoji (🏆 ≥80% · 💪 50–79% · 📚 <50%) is the fallback when streak data is unavailable. See §6 "Streak & Freeze".

---

## 8. Answer Evaluation

Function `checkAnswer()` in `src/SophiaLingo.jsx`.

**Normalization:** lowercase → umlaut substitution (ä→ae, ö→oe, ü→ue, ß→ss) → strip punctuation → collapse whitespace.

**Evaluation order:**
1. Split correct answer on `,;/` for variants
2. Exact normalized match → **"correct"**
3. Levenshtein distance ≤ threshold → **"almost"**
   - ≤4 chars: threshold 1
   - ≤8 chars: threshold 2
   - >8 chars: threshold 3
4. Substring match (≥3 chars) → **"almost"**
5. No match → **"incorrect"**

---

## 9. Design System

### Colors — Leitner box badges

| Box | Background | Text |
|-----|-----------|------|
| 1 (coral) | `#FDEAE4` | `#C25636` |
| 2 (gold) | `#FEF3E2` | `#B87A2B` |
| 3 (teal) | `#E8F5F0` | `#1E7D60` |
| 4 (blue) | `#E3F0FC` | `#2563A8` |
| 5 (purple) | `#EDE9FE` | `#6D48C4` |

### Colors — answer feedback

| Result | Color |
|--------|-------|
| Correct | `#2A9D8F` (teal) |
| Almost | `#F4A261` (orange) |
| Incorrect | `#E76F51` (red) |

### Typography

DM Sans, loaded via Google Fonts CDN. All sizing in `rem`/`px` inline on elements.

### Animations

| Name | Duration | Used for |
|------|----------|---------|
| `spin` | 0.8s | Loading spinner |
| `slideUp` | 0.35s | Card entrance |
| `fadeIn` | 0.5s | Summary screen |
| `wordIn` | 0.35s (staggered 0.1s/word) | Sentence word-by-word reveal |
| `confettiFall` | 1.5–3s | Celebration confetti |

All animations are defined as `@keyframes` injected via a `<style>` tag inside the component.
