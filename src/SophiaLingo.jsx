import { useState, useEffect, useRef, useCallback } from "react";

const API_URL = "https://script.google.com/macros/s/AKfycbwOnch7in0KD4ktQVGZW-XLhyw2Va8DT2sgqhghpRlxrKkruUDYcrhQlYo9kcAnmNI-/exec";

// ─── Offline POST queue ────────────────────────────────────
const QUEUE_KEY = "sl_queue";

function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch { return []; }
}

function writeQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

async function drainQueue() {
  const q = readQueue();
  if (!q.length) return;
  const failed = [];
  for (const payload of q) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error();
    } catch {
      failed.push(payload);
    }
  }
  writeQueue(failed);
}

async function postOrQueue(payload) {
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error();
  } catch {
    const q = readQueue();
    q.push(payload);
    writeQueue(q);
  }
}

// ─── Fuzzy matching ────────────────────────────────────────
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[äÄ]/g, "ae").replace(/[öÖ]/g, "oe").replace(/[üÜ]/g, "ue").replace(/ß/g, "ss")
    .replace(/[\s,;/()]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1);
    row[0] = i;
    return row;
  });
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)
      );
  return dp[m][n];
}

function checkAnswer(userInput, correctAnswer) {
  const normUser = normalize(userInput);
  const variants = correctAnswer.split(/[,;/]/).map((v) => normalize(v.trim())).filter(Boolean);

  for (const variant of variants) {
    if (normUser === variant) return "correct";
    const dist = levenshtein(normUser, variant);
    const threshold = variant.length <= 4 ? 1 : variant.length <= 8 ? 2 : 3;
    if (dist <= threshold) return "almost";
  }

  const normFull = normalize(correctAnswer);
  if (normFull.includes(normUser) && normUser.length >= 3) return "almost";

  return "incorrect";
}

// ─── Spanish cloze (Lückentext) helpers ───────────────────
// Spanish-aware normalizer — distinct from the German `normalize` above
// (which substitutes ä→ae etc.). Here Sophia types a SPANISH word, so we
// strip Spanish accents, drop punctuation, and collapse whitespace.
function normalizeEs(str) {
  return str
    .toLowerCase()
    .replace(/[áàâ]/g, "a").replace(/[éèê]/g, "e").replace(/[íìî]/g, "i")
    .replace(/[óòô]/g, "o").replace(/[úùûü]/g, "u").replace(/ñ/g, "n")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Assemble 4 shuffled options: the answer plus up to 3 distractor source words
// drawn from the rest of the pool (deduped, never equal to the answer).
function buildClozeOptions(answer, distractorPool) {
  const seen = new Set([normalizeEs(answer)]);
  const distractors = [];
  for (const cand of [...distractorPool].sort(() => Math.random() - 0.5)) {
    const c = (cand || "").trim();
    if (!c) continue;
    const norm = normalizeEs(c);
    if (seen.has(norm)) continue;
    seen.add(norm);
    distractors.push(c);
    if (distractors.length >= 3) break;
  }
  return [answer, ...distractors].sort(() => Math.random() - 0.5);
}

// Build one cloze round from a word: pick a random sentence slot whose text
// actually contains the source word (case-insensitive), blank it out, and
// assemble 4 multiple-choice options (answer + distractors from the pool).
// Returns null if no slot contains a matchable surface form (skip the word).
function buildClozeRound(word, distractorPool) {
  const sentences = [word.example_sentence, word.example_sentence_2, word.example_sentence_3]
    .filter(Boolean);
  // shuffle slots so a multi-sentence word varies which one is shown
  const shuffled = sentences.sort(() => Math.random() - 0.5);
  const src = (word.source_word || "").trim();
  if (!src) return null;
  const re = new RegExp(escapeRegExp(src), "i");
  for (const sentence of shuffled) {
    if (re.test(sentence)) {
      return {
        blanked: sentence.replace(re, "_____"),
        full: sentence,
        answer: src,
        options: buildClozeOptions(src, distractorPool),
        leitner_box: word.leitner_box || 1,
      };
    }
  }
  return null;
}

// Build a pool of 5–10 rounds. Prefer words in box ≥ 2 (already seen) for a
// fairer challenge, then fill remaining slots from the rest. Distractor options
// are drawn from every source word in the pool. A round needs ≥ 2 options to be
// a usable multiple-choice question.
function buildClozePool(words) {
  const distractorPool = words.map((w) => (w.source_word || "").trim()).filter(Boolean);
  const seen = words.filter((w) => (w.leitner_box || 1) >= 2).sort(() => Math.random() - 0.5);
  const fresh = words.filter((w) => (w.leitner_box || 1) < 2).sort(() => Math.random() - 0.5);
  const ordered = [...seen, ...fresh];
  const rounds = [];
  for (const w of ordered) {
    const r = buildClozeRound(w, distractorPool);
    if (r && r.options.length >= 2) rounds.push(r);
    if (rounds.length >= 10) break;
  }
  return rounds;
}

// ─── Streak emotion ladder (mirrors emotionFor in Code.js) ──
// Used to project the post-round emotion on the summary screen.
function emotionFor(streak) {
  if (streak <= 0) return "";
  if (streak === 1) return "😐";
  if (streak <= 3) return "🙂";
  if (streak <= 6) return "😊";
  if (streak <= 13) return "🤠";
  if (streak <= 29) return "😄";
  if (streak <= 59) return "😆";
  if (streak <= 99) return "🤩";
  return "⭐";
}

// ─── Confetti burst ────────────────────────────────────────
function Confetti({ count = 40 }) {
  const colors = ["#E8734A", "#F4A261", "#2A9D8F", "#E9C46A", "#264653", "#E76F51", "#A8DADC"];
  const pieces = Array.from({ length: count }, (_, i) => {
    const left = Math.random() * 100;
    const delay = Math.random() * 0.5;
    const dur = 1.5 + Math.random() * 1.5;
    const rot = Math.random() * 720 - 360;
    const size = 6 + Math.random() * 8;
    const color = colors[i % colors.length];
    const shape = Math.random() > 0.5 ? "50%" : "2px";
    return (
      <div
        key={i}
        style={{
          position: "absolute",
          left: `${left}%`,
          top: "-10px",
          width: `${size}px`,
          height: `${size}px`,
          backgroundColor: color,
          borderRadius: shape,
          animation: `confettiFall ${dur}s ease-in ${delay}s forwards`,
          transform: `rotate(${rot}deg)`,
          opacity: 0,
        }}
      />
    );
  });
  return <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, pointerEvents: "none", zIndex: 999, overflow: "hidden" }}>{pieces}</div>;
}

// ─── Leitner box palette (SSOT Design System) ──────────────
const boxColors = {
  1: { bg: "#FDEAE4", text: "#C25636" },
  2: { bg: "#FEF3E2", text: "#B87A2B" },
  3: { bg: "#E8F5F0", text: "#1E7D60" },
  4: { bg: "#E3F0FC", text: "#2563A8" },
  5: { bg: "#EDE9FE", text: "#6D48C4" },
};

// ─── Box badge ─────────────────────────────────────────────
function BoxBadge({ box }) {
  const c = boxColors[box] || boxColors[1];
  return (
    <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: "12px", fontSize: "12px", fontWeight: 600, backgroundColor: c.bg, color: c.text, letterSpacing: "0.3px" }}>
      Box {box}
    </span>
  );
}

// ─── Progress dots ─────────────────────────────────────────
function ProgressDots({ total, current, results }) {
  return (
    <div style={{ display: "flex", gap: "6px", justifyContent: "center", margin: "0 0 24px" }}>
      {Array.from({ length: total }, (_, i) => {
        const r = results[i];
        const active = i === current;
        let bg = "#D4CFC6";
        if (r === "correct") bg = "#2A9D8F";
        else if (r === "almost") bg = "#F4A261";
        else if (r === "incorrect") bg = "#E76F51";
        return (
          <div
            key={i}
            style={{
              width: active ? "24px" : "10px",
              height: "10px",
              borderRadius: "5px",
              backgroundColor: active ? "#3D3229" : bg,
              transition: "all 0.3s ease",
            }}
          />
        );
      })}
    </div>
  );
}

// ─── Main App ──────────────────────────────────────────────
export default function SophiaLingo() {
  const [phase, setPhase] = useState("loading");
  const [words, setWords] = useState([]);
  const [totalDue, setTotalDue] = useState(0);
  const [current, setCurrent] = useState(0);
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState(null);
  const [results, setResults] = useState([]);
  const [sessionScore, setSessionScore] = useState({ correct: 0, almost: 0, incorrect: 0 });
  const [showConfetti, setShowConfetti] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const [editing, setEditing] = useState(null);   // null | "source" | "target"
  const [editValue, setEditValue] = useState("");
  const [showSentence, setShowSentence] = useState(false);
  const [showHint, setShowHint] = useState(false);        // pre-answer hint sentence screen
  const [streakAtLoad, setStreakAtLoad] = useState(null);  // streak snapshot at app open
  const [stats, setStats] = useState(null);                // getStats snapshot (box distribution + lifetime accuracy)
  const [sentenceSlots, setSentenceSlots] = useState([]);
  const [hintSlots, setHintSlots] = useState([]);          // per-word hint sentence slot (null = no hint)
  // ─── Lückentext (cloze) — local BONUS practice, no Leitner/session effects ──
  const [clozeRounds, setClozeRounds] = useState([]);
  const [clozeIdx, setClozeIdx] = useState(0);
  const [clozeFeedback, setClozeFeedback] = useState(null); // null | { result, selected }
  const [clozeLoading, setClozeLoading] = useState(false);
  // ─── Nemesis-Wörter spotlight ──────────────────────────────
  const [hardWords, setHardWords] = useState([]);
  const [nemesisStatus, setNemesisStatus] = useState("idle"); // idle | loading | ready | error
  const [nemesisEdit, setNemesisEdit] = useState(null);    // null | { word_id, field: "source"|"target" }
  const [nemesisEditValue, setNemesisEditValue] = useState("");
  // Practice-only drill of the nemesis words. NEVER calls updateWord/logSession —
  // no Leitner box changes, no session logging (SSOT invariant 4.1).
  const [drillWords, setDrillWords] = useState([]);        // shuffled copy of hardWords for the current round
  const [drillIndex, setDrillIndex] = useState(0);
  const [drillInput, setDrillInput] = useState("");
  const [drillFeedback, setDrillFeedback] = useState(null); // null | { result, correctAnswer }
  const [drillResults, setDrillResults] = useState([]);
  const [drillDone, setDrillDone] = useState(false);
  const drillInputRef = useRef(null);

  // Drain offline queue on load and when connection returns
  useEffect(() => {
    drainQueue();
    window.addEventListener("online", drainQueue);
    return () => window.removeEventListener("online", drainQueue);
  }, []);

  // Load words
  useEffect(() => {
    fetch(`${API_URL}?action=getWords&limit=10`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setError(data.error); setPhase("error"); return; }
        if (!data.words || data.words.length === 0) { setPhase("empty"); return; }
        setWords(data.words);
        setTotalDue(data.total_due);
        setResults(new Array(data.words.length).fill(null));
        const slots = data.words.map((w) => {
          const available = [1, 2, 3].filter((s) => (s === 1 ? w.example_sentence : w[`example_sentence_${s}`]));
          return available.length ? available[Math.floor(Math.random() * available.length)] : 1;
        });
        setSentenceSlots(slots);
        // Hint sentence: prefer a slot different from the post-eval one so Sophia sees
        // two distinct sentences per word; fall back to the same slot if only one exists.
        const hints = data.words.map((w, i) => {
          const available = [1, 2, 3].filter((s) => (s === 1 ? w.example_sentence : w[`example_sentence_${s}`]));
          if (!available.length) return null;
          const others = available.filter((s) => s !== slots[i]);
          const pool = others.length ? others : available;
          return pool[Math.floor(Math.random() * pool.length)];
        });
        setHintSlots(hints);
        setPhase("quiz");
      })
      .catch((err) => { setError(err.message); setPhase("error"); });
  }, []);

  // Load streak in parallel (fail-soft — never blocks the quiz)
  useEffect(() => {
    fetch(`${API_URL}?action=getStreak`)
      .then((r) => r.json())
      .then((d) => { if (!d.error) setStreakAtLoad(d); })
      .catch(() => {});
  }, []);

  // Load stats in parallel for the "Mein Fortschritt" screen (fail-soft — read-only)
  useEffect(() => {
    fetch(`${API_URL}?action=getStats`)
      .then((r) => r.json())
      .then((d) => { if (!d.error) setStats(d); })
      .catch(() => {});
  }, []);

  // "Mein Fortschritt" is read-only — Enter returns to the summary (speed over ceremony)
  useEffect(() => {
    if (phase !== "fortschritt") return;
    const onKey = (e) => { if (e.key === "Enter") setPhase("summary"); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  // Focus input when new word appears
  useEffect(() => {
    if (phase === "quiz" && !feedback && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [current, phase, feedback]);

  // ─── Lückentext handlers ──────────────────────────────────
  // Enter cloze mode from Summary. Prefer the richer getSentences pool;
  // fall back to the words already fetched for the quiz. Never touches Leitner.
  const startCloze = useCallback(async () => {
    setClozeLoading(true);
    let pool = [];
    try {
      const res = await fetch(`${API_URL}?action=getSentences`);
      const data = await res.json();
      if (data.words && data.words.length) pool = data.words;
    } catch { /* fall through to quiz words */ }
    if (!pool.length) pool = words;
    const rounds = buildClozePool(pool);
    setClozeLoading(false);
    if (!rounds.length) return; // nothing usable — stay on summary
    setShowConfetti(false);
    setClozeRounds(rounds);
    setClozeIdx(0);
    setClozeFeedback(null);
    setPhase("luecke");
  }, [words]);

  // Multiple-choice pick: lock in the chosen option and score it. Exact match
  // against the answer — a distractor is never "almost".
  const selectCloze = useCallback((option) => {
    if (clozeFeedback) return;
    const round = clozeRounds[clozeIdx];
    const result = normalizeEs(option) === normalizeEs(round.answer) ? "correct" : "incorrect";
    setClozeFeedback({ result, selected: option });
  }, [clozeFeedback, clozeRounds, clozeIdx]);

  const nextCloze = useCallback(() => {
    if (clozeIdx + 1 >= clozeRounds.length) {
      setPhase("summary");
      return;
    }
    setClozeIdx((i) => i + 1);
    setClozeFeedback(null);
  }, [clozeIdx, clozeRounds]);

  // Keyboard: 1–4 pick an option, Enter advances after feedback (speed over ceremony)
  useEffect(() => {
    if (phase !== "luecke") return;
    const onKey = (e) => {
      const round = clozeRounds[clozeIdx];
      if (!round) return;
      if (!clozeFeedback) {
        const n = parseInt(e.key, 10);
        if (n >= 1 && n <= round.options.length) selectCloze(round.options[n - 1]);
      } else if (e.key === "Enter") {
        nextCloze();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, clozeFeedback, clozeRounds, clozeIdx, selectCloze, nextCloze]);

  const submitAnswer = useCallback(() => {
    if (!input.trim() || feedback) return;
    const word = words[current];
    const result = checkAnswer(input, word.target_word);
    setFeedback({ result, correctAnswer: word.target_word });

    const newResults = [...results];
    newResults[current] = result;
    setResults(newResults);

    setSessionScore((prev) => ({ ...prev, [result]: prev[result] + 1 }));

    // Update word in backend
    postOrQueue({
      action: "updateWord",
      word_id: word.word_id,
      correct: result === "correct" || result === "almost",
    });
  }, [input, feedback, words, current, results]);

  const nextWord = useCallback(() => {
    setEditing(null);
    const slot = sentenceSlots[current] || 1;
    const activeSentence = slot === 1 ? words[current]?.example_sentence : words[current]?.[`example_sentence_${slot}`];
    if (!showSentence && activeSentence) {
      setShowSentence(true);
      return;
    }
    setShowSentence(false);
    setShowHint(false);
    if (current + 1 >= words.length) {
      // Log session
      const correct = results.filter((r) => r === "correct").length + results.filter((r) => r === "almost").length;
      postOrQueue({ action: "logSession", words_tested: words.length, correct });

      if (correct >= words.length * 0.7) setShowConfetti(true);
      setPhase("summary");
    } else {
      setCurrent((c) => c + 1);
      setInput("");
      setFeedback(null);
    }
  }, [current, words, results, showSentence, sentenceSlots]);

  const dismissHint = useCallback(() => {
    setShowHint(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      if (!feedback) submitAnswer();
      else nextWord();
    }
  };

  const handleEditSave = (field) => {
    const word = words[current];
    const trimmed = editValue.trim();
    if (!trimmed) { setEditing(null); return; }

    postOrQueue({
      action: "editWord",
      word_id: word.word_id,
      [field === "source" ? "source_word" : "target_word"]: trimmed,
    });

    const newWords = [...words];
    if (field === "source") {
      newWords[current] = { ...newWords[current], source_word: trimmed };
    } else {
      newWords[current] = { ...newWords[current], target_word: trimmed };
      setFeedback((prev) => prev ? { ...prev, correctAnswer: trimmed } : prev);
    }
    setWords(newWords);
    setEditing(null);
  };

  const handleSentenceEval = (e, value) => {
    e.stopPropagation();
    const word = words[current];
    const slot = sentenceSlots[current] || 1;
    const evalKey = slot === 1 ? "sentence_eval" : `sentence_eval_${slot}`;
    const currentEval = word[evalKey] || "";
    const newEval = currentEval === value ? "" : value;

    const newWords = [...words];
    newWords[current] = { ...newWords[current], [evalKey]: newEval };
    setWords(newWords);

    postOrQueue({
      action: "evalSentence",
      word_id: word.word_id,
      slot,
      eval: newEval,
    });
  };

  // ─── Nemesis-Wörter ────────────────────────────────────
  const openNemesis = useCallback(() => {
    setNemesisEdit(null);
    setPhase("nemesis");
    setNemesisStatus("loading");
    fetch(`${API_URL}?action=getHardWords&limit=5`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setNemesisStatus("error"); return; }
        setHardWords(data.words || []);
        setNemesisStatus("ready");
      })
      .catch(() => setNemesisStatus("error"));
  }, []);

  const closeNemesis = useCallback(() => {
    setNemesisEdit(null);
    setPhase("summary");
  }, []);

  // Reuse the editWord endpoint (same as the quiz feedback box) per card.
  const saveNemesisEdit = (wordId, field) => {
    const trimmed = nemesisEditValue.trim();
    if (!trimmed) { setNemesisEdit(null); return; }
    postOrQueue({
      action: "editWord",
      word_id: wordId,
      [field === "source" ? "source_word" : "target_word"]: trimmed,
    });
    setHardWords((prev) => prev.map((w) =>
      w.word_id === wordId
        ? { ...w, [field === "source" ? "source_word" : "target_word"]: trimmed }
        : w
    ));
    setNemesisEdit(null);
  };

  // Enter returns to the summary (unless an inline edit is open).
  useEffect(() => {
    if (phase !== "nemesis") return;
    const onKey = (e) => { if (e.key === "Enter" && !nemesisEdit) closeNemesis(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, nemesisEdit, closeNemesis]);

  // ─── Nemesis practice drill (no Leitner / no logging) ──────
  const startDrill = useCallback(() => {
    // Fresh shuffle each round so the order isn't always the ranked list.
    const shuffled = [...hardWords];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    setDrillWords(shuffled);
    setDrillIndex(0);
    setDrillInput("");
    setDrillFeedback(null);
    setDrillResults([]);
    setDrillDone(false);
    setPhase("drill");
  }, [hardWords]);

  const submitDrill = useCallback(() => {
    if (!drillInput.trim() || drillFeedback) return;
    const word = drillWords[drillIndex];
    const result = checkAnswer(drillInput, word.target_word);
    setDrillFeedback({ result, correctAnswer: word.target_word });
    setDrillResults((prev) => { const n = [...prev]; n[drillIndex] = result; return n; });
    // Practice only — deliberately no postOrQueue(updateWord/logSession).
  }, [drillInput, drillFeedback, drillWords, drillIndex]);

  const nextDrill = useCallback(() => {
    if (drillIndex + 1 >= drillWords.length) {
      setDrillDone(true);
    } else {
      setDrillIndex((i) => i + 1);
      setDrillInput("");
      setDrillFeedback(null);
    }
  }, [drillIndex, drillWords]);

  // Focus the drill input on each new word.
  useEffect(() => {
    if (phase === "drill" && !drillDone && !drillFeedback) {
      setTimeout(() => drillInputRef.current?.focus(), 100);
    }
  }, [phase, drillIndex, drillFeedback, drillDone]);

  // On the drill-finished screen, Enter returns to the spotlight.
  useEffect(() => {
    if (phase !== "drill" || !drillDone) return;
    const onKey = (e) => { if (e.key === "Enter") setPhase("nemesis"); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, drillDone]);

  const handleDrillKeyDown = (e) => {
    if (e.key === "Enter") {
      if (!drillFeedback) submitDrill();
      else nextDrill();
    }
  };

  // ─── Render ────────────────────────────────────────────
  return (
    <div style={styles.shell}>
      <style>{globalCSS}</style>

      {showConfetti && <Confetti />}

      <div style={styles.container}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.logo}>SophiaLingo</div>
          {streakAtLoad && streakAtLoad.streak >= 1 ? (
            <div style={styles.streakBadge}>
              {streakAtLoad.frozen ? (
                <span>🧊</span>
              ) : (
                <span style={{ display: "inline-block", animation: "flameFlicker 2.2s ease-in-out infinite" }}>🔥</span>
              )}
              <span style={styles.streakNum}>{streakAtLoad.streak}</span>
              {streakAtLoad.emotion && <span>{streakAtLoad.emotion}</span>}
            </div>
          ) : (
            <div style={styles.subtitle}>Spanisch → Deutsch</div>
          )}
          {streakAtLoad && streakAtLoad.streak >= 1 && (
            <div style={styles.freezeCounter}>
              <span>❄️</span>
              <span style={styles.freezeNum}>{streakAtLoad.freezes}/1</span>
            </div>
          )}
        </div>

        {/* Loading */}
        {phase === "loading" && (
          <div style={styles.center}>
            <div style={styles.spinner} />
            <p style={styles.loadingText}>Wörter werden geladen...</p>
          </div>
        )}

        {/* Error */}
        {phase === "error" && (
          <div style={styles.center}>
            <div style={{ fontSize: "48px", marginBottom: "16px" }}>😵</div>
            <p style={styles.errorText}>Etwas ist schiefgelaufen</p>
            <p style={{ ...styles.mutedText, maxWidth: "300px" }}>{error}</p>
            <button style={styles.primaryBtn} onClick={() => window.location.reload()}>Nochmal versuchen</button>
          </div>
        )}

        {/* No words due */}
        {phase === "empty" && (
          <div style={styles.center}>
            <div style={{ fontSize: "56px", marginBottom: "16px" }}>🎉</div>
            <p style={styles.heroText}>Alles erledigt!</p>
            <p style={styles.mutedText}>Keine Wörter stehen heute zur Wiederholung an. Genieß den Tag!</p>
          </div>
        )}

        {/* Quiz */}
        {phase === "quiz" && words.length > 0 && (
          <div style={styles.quizWrap}>
            <ProgressDots total={words.length} current={current} results={results} />

            <div style={styles.counter}>
              {current + 1} / {words.length}
              {totalDue > words.length && (
                <span style={styles.dueExtra}> · {totalDue} insgesamt fällig</span>
              )}
            </div>

            {/* Sentence reveal */}
            {showSentence && (() => {
              const slot = sentenceSlots[current] || 1;
              const sentence = slot === 1 ? words[current].example_sentence : words[current][`example_sentence_${slot}`];
              const evalKey = slot === 1 ? "sentence_eval" : `sentence_eval_${slot}`;
              const currentEval = words[current][evalKey] || "";
              return (
                <div style={styles.sentenceScreen} onClick={nextWord}>
                  <p style={styles.sentenceText}>
                    {sentence.split(" ").map((word, i) => (
                      <span
                        key={i}
                        style={{
                          display: "inline-block",
                          opacity: 0,
                          animation: "wordIn 0.35s ease forwards",
                          animationDelay: `${i * 0.1}s`,
                          marginRight: "0.25em",
                        }}
                      >
                        {word}
                      </span>
                    ))}
                  </p>
                  <div style={styles.sentenceEvalRow}>
                    <button
                      style={{
                        ...(currentEval === "up" ? styles.thumbBtnActive : styles.thumbBtn),
                        ...(currentEval === "up" ? { transform: "scale(1.15)" } : {}),
                      }}
                      onClick={(e) => handleSentenceEval(e, "up")}
                      title="Guter Satz"
                    >
                      👍
                    </button>
                    <button
                      style={{
                        ...(currentEval === "down" ? styles.thumbBtnActive : styles.thumbBtn),
                        ...(currentEval === "down" ? { transform: "scale(1.15)" } : {}),
                      }}
                      onClick={(e) => handleSentenceEval(e, "down")}
                      title="Schlechter Satz"
                    >
                      👎
                    </button>
                  </div>
                  <span style={styles.sentenceTapHint}>Tippe um fortzufahren</span>
                </div>
              );
            })()}

            {/* Hint sentence (pre-answer) */}
            {showHint && (() => {
              const slot = hintSlots[current] || 1;
              const sentence = slot === 1 ? words[current].example_sentence : words[current][`example_sentence_${slot}`];
              return (
                <div style={styles.sentenceScreen} onClick={dismissHint}>
                  <span style={styles.hintLabel}>💡 Tipp</span>
                  <p style={styles.sentenceText}>
                    {sentence.split(" ").map((word, i) => (
                      <span
                        key={i}
                        style={{
                          display: "inline-block",
                          opacity: 0,
                          animation: "wordIn 0.35s ease forwards",
                          animationDelay: `${i * 0.1}s`,
                          marginRight: "0.25em",
                        }}
                      >
                        {word}
                      </span>
                    ))}
                  </p>
                  <span style={styles.sentenceTapHint}>Tippe um fortzufahren</span>
                </div>
              );
            })()}

            {/* Word card */}
            {!showSentence && !showHint && <div style={styles.card} key={current}>
              <div style={styles.cardMeta}>
                <BoxBadge box={words[current].leitner_box} />
              </div>

              <div style={{ ...styles.spanishWord, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
                {feedback && editing === "source" ? (
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleEditSave("source");
                      if (e.key === "Escape") setEditing(null);
                    }}
                    style={{ ...styles.input, fontSize: "22px", fontWeight: 700, textAlign: "center", width: "auto", minWidth: "120px", padding: "4px 10px", marginBottom: 0 }}
                  />
                ) : (
                  <span>{words[current].source_word}</span>
                )}
                {feedback && editing !== "source" && (
                  <button style={styles.editBtn} onClick={() => { setEditValue(words[current].source_word); setEditing("source"); }} title="Wort bearbeiten">✏</button>
                )}
                {feedback && editing === "source" && (
                  <button style={styles.editBtn} onClick={() => handleEditSave("source")} title="Speichern">💾</button>
                )}
              </div>

              <div style={styles.inputWrap}>
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Übersetzung eingeben..."
                  disabled={!!feedback}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck="false"
                  style={{
                    ...styles.input,
                    borderColor: feedback
                      ? feedback.result === "correct" ? "#2A9D8F"
                        : feedback.result === "almost" ? "#F4A261"
                        : "#E76F51"
                      : "#C9C2B8",
                    backgroundColor: feedback
                      ? feedback.result === "correct" ? "#F0FAF7"
                        : feedback.result === "almost" ? "#FFF8EE"
                        : "#FEF1EE"
                      : "#FDFCFA",
                  }}
                />
              </div>

              {/* Feedback */}
              {feedback && (
                <div style={{ ...styles.feedbackBox, animation: "slideUp 0.3s ease" }}>
                  {feedback.result === "correct" && (
                    <>
                      <div style={styles.feedbackIcon}>✓</div>
                      <div style={{ ...styles.feedbackLabel, color: "#1E7D60" }}>Richtig!</div>
                    </>
                  )}
                  {feedback.result === "almost" && (
                    <>
                      <div style={{ ...styles.feedbackIcon, color: "#B87A2B" }}>≈</div>
                      <div style={{ ...styles.feedbackLabel, color: "#B87A2B" }}>Fast richtig!</div>
                    </>
                  )}
                  {feedback.result === "incorrect" && (
                    <>
                      <div style={{ ...styles.feedbackIcon, color: "#C25636" }}>✗</div>
                      <div style={{ ...styles.feedbackLabel, color: "#C25636" }}>Nicht ganz</div>
                    </>
                  )}
                  <div style={{ ...styles.correctAnswer, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}>
                    {editing === "target" ? (
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleEditSave("target");
                          if (e.key === "Escape") setEditing(null);
                        }}
                        style={{ ...styles.input, fontSize: "14px", fontStyle: "italic", textAlign: "center", width: "auto", minWidth: "100px", padding: "2px 8px", marginBottom: 0 }}
                      />
                    ) : (
                      <span>{feedback.correctAnswer}</span>
                    )}
                    {editing !== "target" && (
                      <button style={styles.editBtn} onClick={() => { setEditValue(feedback.correctAnswer); setEditing("target"); }} title="Antwort bearbeiten">✏</button>
                    )}
                    {editing === "target" && (
                      <button style={styles.editBtn} onClick={() => handleEditSave("target")} title="Speichern">💾</button>
                    )}
                  </div>
                </div>
              )}

              {/* Buttons */}
              <div style={styles.btnRow}>
                {!feedback ? (
                  <>
                    {hintSlots[current] && (
                      <button style={styles.hintBtn} onClick={() => setShowHint(true)}>
                        💡 Tipp
                      </button>
                    )}
                    <button style={{ ...styles.primaryBtn, opacity: input.trim() ? 1 : 0.5 }} onClick={submitAnswer} disabled={!input.trim()}>
                      Prüfen
                    </button>
                  </>
                ) : (
                  <button style={styles.primaryBtn} onClick={nextWord}>
                    {current + 1 >= words.length ? "Ergebnis anzeigen" : "Weiter →"}
                  </button>
                )}
              </div>
            </div>}
          </div>
        )}

        {/* Summary */}
        {phase === "summary" && (
          <div style={{ ...styles.center, animation: "fadeIn 0.5s ease" }}>
            {(() => {
              const s = streakAtLoad;
              const tierEmoji = sessionScore.correct + sessionScore.almost >= words.length * 0.8 ? "🏆"
                : sessionScore.correct + sessionScore.almost >= words.length * 0.5 ? "💪" : "📚";
              const fallback = (
                <>
                  <div style={{ fontSize: "56px", marginBottom: "8px" }}>{tierEmoji}</div>
                  <p style={styles.heroText}>Geschafft!</p>
                  <p style={styles.mutedText}>{words.length} Wörter geübt</p>
                </>
              );
              if (!s) return fallback;

              const newSessionsToday = s.sessions_today + 1;          // this round just completed
              const displayedStreak = s.sessions_today === 0 ? s.streak + 1 : s.streak;
              if (displayedStreak < 1) return fallback;               // defensive — don't rub it in

              const thawed = s.sessions_today === 0 && s.frozen && s.streak >= 1;
              const freezeEarned = s.freezes === 0 && newSessionsToday >= 3;
              let line = null;
              if (thawed) line = "Dein Streak war eingefroren — gerettet! 🧊";
              else if (freezeEarned) line = "Streak-Freeze verdient! ❄️";
              else if (s.freezes === 0 && newSessionsToday < 3) line = `Noch ${3 - newSessionsToday} Runden für einen Streak-Freeze ❄️`;

              return (
                <>
                  <div style={{ fontSize: "56px", marginBottom: "8px" }}>🔥</div>
                  <p style={styles.heroText}>
                    {displayedStreak} {displayedStreak === 1 ? "Tag" : "Tage"} Streak! {emotionFor(displayedStreak)}
                  </p>
                  <p style={styles.mutedText}>{words.length} Wörter geübt</p>
                  {line && <p style={{ ...styles.mutedText, marginTop: "8px", fontWeight: 600, color: "#3D3229" }}>{line}</p>}
                </>
              );
            })()}

            <div style={styles.scoreGrid}>
              <div style={styles.scoreCard}>
                <div style={{ ...styles.scoreNum, color: "#1E7D60" }}>{sessionScore.correct}</div>
                <div style={styles.scoreLabel}>Richtig</div>
              </div>
              <div style={styles.scoreCard}>
                <div style={{ ...styles.scoreNum, color: "#B87A2B" }}>{sessionScore.almost}</div>
                <div style={styles.scoreLabel}>Fast</div>
              </div>
              <div style={styles.scoreCard}>
                <div style={{ ...styles.scoreNum, color: "#C25636" }}>{sessionScore.incorrect}</div>
                <div style={styles.scoreLabel}>Falsch</div>
              </div>
            </div>

            <div style={styles.summaryBar}>
              {(() => {
                const total = words.length || 1;
                const cPct = (sessionScore.correct / total) * 100;
                const aPct = (sessionScore.almost / total) * 100;
                const iPct = (sessionScore.incorrect / total) * 100;
                return (
                  <>
                    <div style={{ ...styles.barSegment, width: `${cPct}%`, backgroundColor: "#2A9D8F" }} />
                    <div style={{ ...styles.barSegment, width: `${aPct}%`, backgroundColor: "#F4A261" }} />
                    <div style={{ ...styles.barSegment, width: `${iPct}%`, backgroundColor: "#E76F51" }} />
                  </>
                );
              })()}
            </div>

            {/* Word-by-word review */}
            <div style={styles.reviewList}>
              {words.map((w, i) => (
                <div key={i} style={styles.reviewRow}>
                  <div style={{
                    ...styles.reviewDot,
                    backgroundColor: results[i] === "correct" ? "#2A9D8F" : results[i] === "almost" ? "#F4A261" : "#E76F51",
                  }} />
                  <div style={styles.reviewWord}>{w.source_word}</div>
                  <div style={styles.reviewArrow}>→</div>
                  <div style={styles.reviewAnswer}>{w.target_word}</div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: "24px" }}>
              <p style={{ ...styles.mutedText, fontSize: "13px" }}>
                {totalDue > words.length
                  ? `Noch ${totalDue - words.length} Wörter fällig — nochmal starten?`
                  : "Morgen geht's weiter. ¡Hasta mañana!"
                }
              </p>
              {totalDue > words.length && (
                <button style={{ ...styles.primaryBtn, marginTop: "12px" }} onClick={() => window.location.reload()}>
                  Nächste Runde
                </button>
              )}
            </div>

            {/* Secondary practice modes (sibling screens land here too) */}
            <div style={styles.secondaryRow}>
              <button style={styles.secondaryBtn} onClick={startCloze} disabled={clozeLoading}>
                {clozeLoading ? "Lädt…" : "✏️ Lückentext"}
              </button>
              <button style={styles.secondaryBtn} onClick={() => setPhase("fortschritt")}>
                📊 Mein Fortschritt
              </button>
              <button style={styles.secondaryBtn} onClick={openNemesis}>
                ⚡ Problemwörter
              </button>
            </div>
          </div>
        )}

        {/* Mein Fortschritt — read-only progress dashboard */}
        {phase === "fortschritt" && (
          <div style={{ ...styles.center, animation: "fadeIn 0.5s ease", justifyContent: "flex-start" }}>
            <p style={{ ...styles.heroText, marginTop: "8px" }}>Mein Fortschritt</p>

            {!stats ? (
              <p style={{ ...styles.mutedText, marginTop: "24px" }}>Statistiken werden geladen…</p>
            ) : (
              <>
                {/* Leitner box distribution */}
                <div style={styles.progressSection}>
                  <p style={styles.progressSectionTitle}>Leitner-Boxen</p>
                  {(() => {
                    const dist = stats.box_distribution || {};
                    const max = Math.max(1, ...[1, 2, 3, 4, 5].map((b) => dist[b] || 0));
                    return [1, 2, 3, 4, 5].map((b) => {
                      const count = dist[b] || 0;
                      const c = boxColors[b];
                      return (
                        <div key={b} style={styles.barRow}>
                          <span style={{ ...styles.barBoxLabel, color: c.text }}>{b}</span>
                          <div style={styles.barTrack}>
                            <div style={{
                              ...styles.barFill,
                              width: `${(count / max) * 100}%`,
                              backgroundColor: c.bg,
                              borderRight: count > 0 ? `3px solid ${c.text}` : "none",
                            }} />
                          </div>
                          <span style={styles.barCount}>{count}</span>
                        </div>
                      );
                    });
                  })()}
                </div>

                {/* Lifetime accuracy */}
                <div style={styles.progressSection}>
                  <div style={styles.bigStat}>{stats.lifetime_accuracy}%</div>
                  <div style={styles.bigStatCaption}>Genauigkeit</div>
                </div>

                {/* Longest streak */}
                <div style={styles.progressSection}>
                  <p style={styles.mutedText}>
                    Längste Serie: <strong style={{ color: "#3D3229" }}>{(streakAtLoad?.longest ?? 0)} {(streakAtLoad?.longest === 1) ? "Tag" : "Tage"}</strong>
                  </p>
                </div>
              </>
            )}

            <button style={{ ...styles.secondaryBtn, marginTop: "28px" }} onClick={() => setPhase("summary")}>
              Zurück
            </button>
          </div>
        )}

        {/* Lückentext (cloze) — BONUS practice, no Leitner/session side effects */}
        {phase === "luecke" && (
          <div style={styles.quizWrap}>
            <div style={styles.clozeTopRow}>
              <button style={styles.backBtn} onClick={() => setPhase("summary")}>← Zurück</button>
              <span style={styles.counter}>{clozeIdx + 1} / {clozeRounds.length}</span>
            </div>

            <div style={styles.card} key={clozeIdx}>
              <div style={styles.clozeLabel}>Lückentext · Welches Wort fehlt?</div>

              {!clozeFeedback ? (
                <p style={styles.clozeSentence}>{clozeRounds[clozeIdx].blanked}</p>
              ) : (
                <p style={styles.clozeSentence}>
                  {clozeRounds[clozeIdx].full.split(" ").map((w, i) => {
                    const isAnswer = normalizeEs(w) === normalizeEs(clozeRounds[clozeIdx].answer);
                    return (
                      <span
                        key={i}
                        style={{
                          display: "inline-block",
                          opacity: 0,
                          animation: "wordIn 0.35s ease forwards",
                          animationDelay: `${i * 0.1}s`,
                          marginRight: "0.25em",
                          fontWeight: isAnswer ? 700 : 400,
                          color: isAnswer ? "#1E7D60" : "#3D3229",
                        }}
                      >
                        {w}
                      </span>
                    );
                  })}
                </p>
              )}

              <div style={styles.clozeOptions}>
                {clozeRounds[clozeIdx].options.map((opt, i) => {
                  const isAnswer = normalizeEs(opt) === normalizeEs(clozeRounds[clozeIdx].answer);
                  const isPicked = clozeFeedback && normalizeEs(opt) === normalizeEs(clozeFeedback.selected);
                  let bg = "#FDFCFA", border = "#C9C2B8", color = "#3D3229";
                  if (clozeFeedback) {
                    if (isAnswer) { bg = "#F0FAF7"; border = "#2A9D8F"; color = "#1E7D60"; }
                    else if (isPicked) { bg = "#FEF1EE"; border = "#E76F51"; color = "#C25636"; }
                    else { color = "#B0A89C"; }
                  }
                  return (
                    <button
                      key={i}
                      onClick={() => selectCloze(opt)}
                      disabled={!!clozeFeedback}
                      style={{
                        ...styles.clozeOption,
                        backgroundColor: bg,
                        borderColor: border,
                        color,
                        cursor: clozeFeedback ? "default" : "pointer",
                      }}
                    >
                      <span style={styles.clozeOptionNum}>{i + 1}</span>
                      {opt}
                    </button>
                  );
                })}
              </div>

              {clozeFeedback && (
                <div style={{ ...styles.feedbackBox, animation: "slideUp 0.3s ease" }}>
                  {clozeFeedback.result === "correct" ? (
                    <div style={{ ...styles.feedbackLabel, color: "#1E7D60" }}>✓ Richtig!</div>
                  ) : (
                    <div style={{ ...styles.feedbackLabel, color: "#C25636" }}>✗ Nicht ganz</div>
                  )}
                  <div style={styles.correctAnswer}>{clozeRounds[clozeIdx].answer}</div>
                </div>
              )}

              {clozeFeedback && (
                <div style={styles.btnRow}>
                  <button style={styles.primaryBtn} onClick={nextCloze}>
                    {clozeIdx + 1 >= clozeRounds.length ? "Geschafft!" : "Weiter →"}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Nemesis-Wörter — problem-words spotlight (read-only + inline edit) */}
        {phase === "nemesis" && (
          <div style={{ ...styles.quizWrap, animation: "fadeIn 0.5s ease" }}>
            <p style={styles.nemesisLede}>
              ⚡ Diese Wörter machen dir zu schaffen — aber du schaffst das!
            </p>

            {nemesisStatus === "loading" && (
              <div style={styles.center}>
                <div style={styles.spinner} />
                <p style={styles.loadingText}>Problemwörter werden geladen...</p>
              </div>
            )}

            {nemesisStatus === "error" && (
              <div style={styles.center}>
                <div style={{ fontSize: "40px", marginBottom: "12px" }}>😵</div>
                <p style={styles.mutedText}>Problemwörter konnten nicht geladen werden.</p>
              </div>
            )}

            {nemesisStatus === "ready" && hardWords.length === 0 && (
              <div style={styles.center}>
                <div style={{ fontSize: "48px", marginBottom: "12px" }}>🌟</div>
                <p style={styles.heroText}>Keine Nemesis-Wörter!</p>
                <p style={styles.mutedText}>Du hast noch keine Wörter falsch beantwortet. Weiter so!</p>
              </div>
            )}

            {nemesisStatus === "ready" && hardWords.length > 0 && hardWords.map((w, i) => {
              const editingSource = nemesisEdit && nemesisEdit.word_id === w.word_id && nemesisEdit.field === "source";
              const editingTarget = nemesisEdit && nemesisEdit.word_id === w.word_id && nemesisEdit.field === "target";
              return (
                <div key={w.word_id} style={{ ...styles.nemesisCard, animationDelay: `${i * 0.06}s` }}>
                  <div style={styles.nemesisCardTop}>
                    <span style={styles.nemesisRank}>#{i + 1}</span>
                    <BoxBadge box={w.leitner_box} />
                  </div>

                  {/* Spanish word + inline edit */}
                  <div style={styles.nemesisSource}>
                    {editingSource ? (
                      <input
                        autoFocus
                        value={nemesisEditValue}
                        onChange={(e) => setNemesisEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveNemesisEdit(w.word_id, "source");
                          if (e.key === "Escape") setNemesisEdit(null);
                        }}
                        style={{ ...styles.input, fontSize: "20px", fontWeight: 700, width: "auto", minWidth: "120px", padding: "4px 10px", marginBottom: 0 }}
                      />
                    ) : (
                      <span>{w.source_word}</span>
                    )}
                    {editingSource ? (
                      <button style={styles.editBtn} onClick={() => saveNemesisEdit(w.word_id, "source")} title="Speichern">💾</button>
                    ) : (
                      <button style={styles.editBtn} onClick={() => { setNemesisEditValue(w.source_word); setNemesisEdit({ word_id: w.word_id, field: "source" }); }} title="Wort bearbeiten">✏</button>
                    )}
                  </div>

                  {/* German answer + inline edit */}
                  <div style={styles.nemesisTarget}>
                    {editingTarget ? (
                      <input
                        autoFocus
                        value={nemesisEditValue}
                        onChange={(e) => setNemesisEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveNemesisEdit(w.word_id, "target");
                          if (e.key === "Escape") setNemesisEdit(null);
                        }}
                        style={{ ...styles.input, fontSize: "14px", fontStyle: "italic", width: "auto", minWidth: "100px", padding: "2px 8px", marginBottom: 0 }}
                      />
                    ) : (
                      <span>{w.target_word}</span>
                    )}
                    {editingTarget ? (
                      <button style={styles.editBtn} onClick={() => saveNemesisEdit(w.word_id, "target")} title="Speichern">💾</button>
                    ) : (
                      <button style={styles.editBtn} onClick={() => { setNemesisEditValue(w.target_word); setNemesisEdit({ word_id: w.word_id, field: "target" }); }} title="Antwort bearbeiten">✏</button>
                    )}
                  </div>

                  {/* Tally pill */}
                  <div style={styles.nemesisTally}>
                    <span style={{ color: "#C25636", fontWeight: 600 }}>{w.times_wrong}× falsch</span>
                    <span style={{ color: "#B0A89C" }}> · </span>
                    <span style={{ color: "#1E7D60", fontWeight: 600 }}>{w.times_correct}× richtig</span>
                  </div>
                </div>
              );
            })}

            <div style={styles.secondaryRow}>
              {nemesisStatus === "ready" && hardWords.length > 0 && (
                <button style={styles.primaryBtn} onClick={startDrill}>
                  ▶ Jetzt üben
                </button>
              )}
              <button style={styles.secondaryBtn} onClick={closeNemesis}>
                ← Zurück
              </button>
            </div>
          </div>
        )}

        {/* Nemesis practice drill — practice only, no Leitner / no logging */}
        {phase === "drill" && (
          <div style={{ ...styles.quizWrap, animation: "fadeIn 0.4s ease" }}>
            {!drillDone ? (
              <>
                <ProgressDots total={drillWords.length} current={drillIndex} results={drillResults} />
                <div style={styles.counter}>
                  Übung · {drillIndex + 1} / {drillWords.length}
                </div>
                <div style={styles.card} key={drillIndex}>
                  <div style={styles.cardMeta}>
                    <BoxBadge box={drillWords[drillIndex].leitner_box} />
                    <span style={styles.drillNote}>zählt nicht für die Box</span>
                  </div>

                  <div style={styles.spanishWord}>{drillWords[drillIndex].source_word}</div>

                  <div style={styles.inputWrap}>
                    <input
                      ref={drillInputRef}
                      type="text"
                      value={drillInput}
                      onChange={(e) => setDrillInput(e.target.value)}
                      onKeyDown={handleDrillKeyDown}
                      placeholder="Übersetzung eingeben..."
                      disabled={!!drillFeedback}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck="false"
                      style={{
                        ...styles.input,
                        borderColor: drillFeedback
                          ? drillFeedback.result === "correct" ? "#2A9D8F"
                            : drillFeedback.result === "almost" ? "#F4A261"
                            : "#E76F51"
                          : "#C9C2B8",
                        backgroundColor: drillFeedback
                          ? drillFeedback.result === "correct" ? "#F0FAF7"
                            : drillFeedback.result === "almost" ? "#FFF8EE"
                            : "#FEF1EE"
                          : "#FDFCFA",
                      }}
                    />
                  </div>

                  {drillFeedback && (
                    <div style={{ ...styles.feedbackBox, animation: "slideUp 0.3s ease" }}>
                      {drillFeedback.result === "correct" && (
                        <>
                          <div style={styles.feedbackIcon}>✓</div>
                          <div style={{ ...styles.feedbackLabel, color: "#1E7D60" }}>Richtig!</div>
                        </>
                      )}
                      {drillFeedback.result === "almost" && (
                        <>
                          <div style={{ ...styles.feedbackIcon, color: "#B87A2B" }}>≈</div>
                          <div style={{ ...styles.feedbackLabel, color: "#B87A2B" }}>Fast richtig!</div>
                        </>
                      )}
                      {drillFeedback.result === "incorrect" && (
                        <>
                          <div style={{ ...styles.feedbackIcon, color: "#C25636" }}>✗</div>
                          <div style={{ ...styles.feedbackLabel, color: "#C25636" }}>Nicht ganz</div>
                        </>
                      )}
                      <div style={styles.correctAnswer}>{drillFeedback.correctAnswer}</div>
                    </div>
                  )}

                  <div style={styles.btnRow}>
                    {!drillFeedback ? (
                      <button style={{ ...styles.primaryBtn, opacity: drillInput.trim() ? 1 : 0.5 }} onClick={submitDrill} disabled={!drillInput.trim()}>
                        Prüfen
                      </button>
                    ) : (
                      <button style={styles.primaryBtn} onClick={nextDrill}>
                        {drillIndex + 1 >= drillWords.length ? "Ergebnis anzeigen" : "Weiter →"}
                      </button>
                    )}
                  </div>
                </div>
              </>
            ) : (() => {
              const wrong = drillResults.filter((r) => r === "incorrect").length;
              const cleanSweep = wrong === 0;
              return (
                <div style={{ ...styles.center, animation: "fadeIn 0.5s ease" }}>
                  {cleanSweep && <Confetti />}
                  <div style={{ fontSize: "56px", marginBottom: "8px" }}>{cleanSweep ? "🏆" : "💪"}</div>
                  <p style={styles.heroText}>
                    {cleanSweep ? "Heute hast du gewonnen." : "Gut geübt!"}
                  </p>
                  <p style={styles.mutedText}>
                    {cleanSweep
                      ? "Alle Nemesis-Wörter gemeistert — keine einzige Niederlage!"
                      : `${drillWords.length - wrong} von ${drillWords.length} richtig. Diese Übung zählt nicht für die Box — nur fürs Selbstvertrauen.`}
                  </p>
                  <div style={styles.secondaryRow}>
                    <button style={styles.primaryBtn} onClick={startDrill}>
                      ↻ Nochmal üben
                    </button>
                    <button style={styles.secondaryBtn} onClick={() => setPhase("nemesis")}>
                      ← Zurück
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* Footer */}
        <div style={styles.footer}>
          SophiaLingo · Leitner-Box Spaced Repetition
        </div>
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────
const styles = {
  sentenceScreen: {
    backgroundColor: "#FDFCFA",
    borderRadius: "20px",
    boxShadow: "0 2px 16px rgba(61,50,41,0.08)",
    padding: "48px 32px 36px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "260px",
    cursor: "pointer",
    userSelect: "none",
  },
  sentenceText: {
    fontSize: "22px",
    lineHeight: 1.55,
    color: "#3D3229",
    textAlign: "center",
    fontWeight: 400,
    fontStyle: "italic",
    marginBottom: "32px",
  },
  sentenceTapHint: {
    fontSize: "12px",
    color: "#B5ADA4",
    letterSpacing: "0.5px",
    textTransform: "uppercase",
    fontWeight: 500,
  },
  sentenceEvalRow: {
    display: "flex",
    gap: "16px",
    marginBottom: "20px",
  },
  thumbBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: "22px",
    padding: "4px 8px",
    borderRadius: "8px",
    lineHeight: 1,
    opacity: 0.3,
    transition: "opacity 0.15s, transform 0.1s",
  },
  thumbBtnActive: {
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: "22px",
    padding: "4px 8px",
    borderRadius: "8px",
    lineHeight: 1,
    opacity: 1,
    transition: "opacity 0.15s, transform 0.1s",
  },
  editBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: "14px",
    padding: "0 4px",
    lineHeight: 1,
    opacity: 0.45,
    verticalAlign: "middle",
  },
  shell: {
    minHeight: "100vh",
    background: "linear-gradient(168deg, #F5F0E8 0%, #EDE6DA 40%, #E8DFD0 100%)",
    fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
    color: "#3D3229",
    padding: "0",
  },
  container: {
    maxWidth: "440px",
    margin: "0 auto",
    padding: "24px 20px 40px",
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    position: "relative",
    textAlign: "center",
    marginBottom: "32px",
    paddingTop: "12px",
  },
  logo: {
    fontSize: "28px",
    fontWeight: 700,
    letterSpacing: "-0.5px",
    color: "#3D3229",
    marginBottom: "4px",
  },
  subtitle: {
    fontSize: "13px",
    color: "#8A7F72",
    letterSpacing: "1.5px",
    textTransform: "uppercase",
    fontWeight: 500,
  },
  streakBadge: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    fontSize: "18px",
    lineHeight: 1,
  },
  streakNum: {
    fontSize: "18px",
    fontWeight: 700,
    color: "#3D3229",
    letterSpacing: "-0.3px",
  },
  freezeCounter: {
    position: "absolute",
    top: "12px",
    right: "0",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "14px",
    color: "#8A7F72",
    lineHeight: 1,
  },
  freezeNum: {
    fontWeight: 600,
  },
  center: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
  },
  spinner: {
    width: "32px",
    height: "32px",
    border: "3px solid #D4CFC6",
    borderTop: "3px solid #E8734A",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
    marginBottom: "16px",
  },
  loadingText: {
    color: "#8A7F72",
    fontSize: "15px",
  },
  errorText: {
    fontSize: "20px",
    fontWeight: 600,
    marginBottom: "8px",
  },
  heroText: {
    fontSize: "26px",
    fontWeight: 700,
    marginBottom: "8px",
    letterSpacing: "-0.3px",
  },
  mutedText: {
    color: "#8A7F72",
    fontSize: "15px",
    lineHeight: 1.5,
  },
  quizWrap: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
  },
  counter: {
    textAlign: "center",
    fontSize: "13px",
    color: "#8A7F72",
    marginBottom: "16px",
    fontWeight: 500,
  },
  dueExtra: {
    color: "#B0A89C",
  },
  card: {
    backgroundColor: "#FDFCFA",
    borderRadius: "16px",
    padding: "28px 24px",
    boxShadow: "0 1px 3px rgba(61,50,41,0.06), 0 8px 24px rgba(61,50,41,0.04)",
    border: "1px solid rgba(61,50,41,0.06)",
    animation: "slideUp 0.35s ease",
  },
  cardMeta: {
    marginBottom: "20px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  spanishWord: {
    fontSize: "28px",
    fontWeight: 700,
    textAlign: "center",
    marginBottom: "28px",
    letterSpacing: "-0.3px",
    lineHeight: 1.3,
    color: "#2C2218",
  },
  inputWrap: {
    marginBottom: "16px",
  },
  input: {
    width: "100%",
    padding: "14px 16px",
    fontSize: "17px",
    border: "2px solid #C9C2B8",
    borderRadius: "10px",
    outline: "none",
    fontFamily: "'DM Sans', sans-serif",
    color: "#3D3229",
    transition: "border-color 0.2s, background-color 0.2s",
    boxSizing: "border-box",
  },
  feedbackBox: {
    textAlign: "center",
    padding: "16px 0 8px",
  },
  feedbackIcon: {
    fontSize: "32px",
    fontWeight: 700,
    color: "#1E7D60",
    marginBottom: "4px",
  },
  feedbackLabel: {
    fontSize: "16px",
    fontWeight: 600,
    marginBottom: "4px",
  },
  correctAnswer: {
    fontSize: "15px",
    color: "#6B5F52",
    fontStyle: "italic",
    marginTop: "4px",
  },
  btnRow: {
    display: "flex",
    justifyContent: "center",
    gap: "12px",
    marginTop: "16px",
  },
  hintBtn: {
    padding: "12px 22px",
    fontSize: "15px",
    fontWeight: 600,
    color: "#B87A2B",
    backgroundColor: "#FEF3E2",
    border: "none",
    borderRadius: "10px",
    cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif",
    transition: "transform 0.15s, box-shadow 0.15s",
  },
  hintLabel: {
    fontSize: "12px",
    color: "#B87A2B",
    fontWeight: 600,
    letterSpacing: "0.5px",
    textTransform: "uppercase",
    marginBottom: "20px",
  },
  primaryBtn: {
    padding: "12px 36px",
    fontSize: "15px",
    fontWeight: 600,
    color: "#FDFCFA",
    backgroundColor: "#E8734A",
    border: "none",
    borderRadius: "10px",
    cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif",
    transition: "transform 0.15s, box-shadow 0.15s",
    boxShadow: "0 2px 8px rgba(232,115,74,0.25)",
  },
  scoreGrid: {
    display: "flex",
    gap: "16px",
    margin: "24px 0 16px",
  },
  scoreCard: {
    flex: 1,
    backgroundColor: "#FDFCFA",
    borderRadius: "12px",
    padding: "16px 12px",
    textAlign: "center",
    boxShadow: "0 1px 3px rgba(61,50,41,0.06)",
    border: "1px solid rgba(61,50,41,0.06)",
  },
  scoreNum: {
    fontSize: "28px",
    fontWeight: 700,
    lineHeight: 1,
    marginBottom: "4px",
  },
  scoreLabel: {
    fontSize: "12px",
    color: "#8A7F72",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  summaryBar: {
    display: "flex",
    height: "8px",
    borderRadius: "4px",
    overflow: "hidden",
    backgroundColor: "#E8E3DA",
    width: "100%",
    maxWidth: "320px",
    margin: "0 auto 24px",
  },
  barSegment: {
    height: "100%",
    transition: "width 0.5s ease",
  },
  reviewList: {
    width: "100%",
    maxWidth: "360px",
    textAlign: "left",
  },
  reviewRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 0",
    borderBottom: "1px solid rgba(61,50,41,0.06)",
    fontSize: "14px",
  },
  reviewDot: {
    width: "8px",
    height: "8px",
    borderRadius: "4px",
    flexShrink: 0,
  },
  reviewWord: {
    fontWeight: 600,
    flex: 1,
    color: "#3D3229",
  },
  reviewArrow: {
    color: "#B0A89C",
    flexShrink: 0,
  },
  reviewAnswer: {
    flex: 1,
    color: "#6B5F52",
    textAlign: "right",
  },
  secondaryRow: {
    display: "flex",
    justifyContent: "center",
    gap: "12px",
    marginTop: "20px",
    flexWrap: "wrap",
  },
  secondaryBtn: {
    padding: "12px 24px",
    fontSize: "15px",
    fontWeight: 600,
    color: "#6B5F52",
    backgroundColor: "#FDFCFA",
    border: "1px solid rgba(61,50,41,0.12)",
    borderRadius: "10px",
    cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif",
    transition: "transform 0.15s, box-shadow 0.15s",
    boxShadow: "0 1px 3px rgba(61,50,41,0.06)",
  },
  progressSection: {
    width: "100%",
    maxWidth: "360px",
    margin: "24px auto 0",
    textAlign: "center",
  },
  progressSectionTitle: {
    fontSize: "12px",
    color: "#8A7F72",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    marginBottom: "14px",
    textAlign: "left",
  },
  barRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginBottom: "8px",
  },
  barBoxLabel: {
    fontSize: "13px",
    fontWeight: 700,
    width: "14px",
    flexShrink: 0,
    textAlign: "center",
  },
  barTrack: {
    flex: 1,
    height: "20px",
    backgroundColor: "#E8E3DA",
    borderRadius: "6px",
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: "6px",
    minWidth: "3px",
    transition: "width 0.5s ease",
  },
  barCount: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#6B5F52",
    width: "28px",
    flexShrink: 0,
    textAlign: "right",
  },
  bigStat: {
    fontSize: "52px",
    fontWeight: 700,
    color: "#2A9D8F",
    lineHeight: 1,
    letterSpacing: "-1px",
  },
  bigStatCaption: {
    fontSize: "13px",
    color: "#8A7F72",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    marginTop: "6px",
  },
  clozeTopRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "20px",
  },
  backBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 600,
    color: "#8A7F72",
    fontFamily: "'DM Sans', sans-serif",
    padding: "4px 0",
  },
  clozeLabel: {
    fontSize: "12px",
    color: "#B87A2B",
    fontWeight: 600,
    letterSpacing: "0.5px",
    textTransform: "uppercase",
    textAlign: "center",
    marginBottom: "20px",
  },
  clozeSentence: {
    fontSize: "21px",
    lineHeight: 1.55,
    color: "#3D3229",
    textAlign: "center",
    fontStyle: "italic",
    marginBottom: "24px",
    minHeight: "60px",
  },
  clozeOptions: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "12px",
    marginBottom: "8px",
  },
  clozeOption: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "14px 16px",
    fontSize: "17px",
    fontWeight: 600,
    border: "2px solid #C9C2B8",
    borderRadius: "10px",
    backgroundColor: "#FDFCFA",
    color: "#3D3229",
    fontFamily: "'DM Sans', sans-serif",
    textAlign: "left",
    transition: "border-color 0.2s, background-color 0.2s, transform 0.15s",
  },
  clozeOptionNum: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "20px",
    height: "20px",
    flexShrink: 0,
    borderRadius: "6px",
    backgroundColor: "rgba(61,50,41,0.07)",
    fontSize: "12px",
    fontWeight: 700,
    color: "#8A7F72",
  },
  drillNote: {
    fontSize: "11px",
    color: "#B0A89C",
    fontStyle: "italic",
    letterSpacing: "0.3px",
  },
  nemesisLede: {
    fontSize: "15px",
    fontWeight: 600,
    color: "#3D3229",
    textAlign: "center",
    lineHeight: 1.5,
    margin: "4px 0 20px",
  },
  nemesisCard: {
    backgroundColor: "#FDFCFA",
    borderRadius: "16px",
    padding: "18px 20px",
    marginBottom: "12px",
    boxShadow: "0 1px 3px rgba(61,50,41,0.06), 0 8px 24px rgba(61,50,41,0.04)",
    border: "1px solid rgba(61,50,41,0.06)",
    opacity: 0,
    animation: "slideUp 0.35s ease forwards",
  },
  nemesisCardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "10px",
  },
  nemesisRank: {
    fontSize: "13px",
    fontWeight: 700,
    color: "#B0A89C",
    letterSpacing: "0.5px",
  },
  nemesisSource: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "22px",
    fontWeight: 700,
    color: "#2C2218",
    letterSpacing: "-0.3px",
    marginBottom: "2px",
  },
  nemesisTarget: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "15px",
    fontStyle: "italic",
    color: "#6B5F52",
    marginBottom: "12px",
  },
  nemesisTally: {
    display: "inline-block",
    fontSize: "13px",
    backgroundColor: "#F5F0E8",
    borderRadius: "20px",
    padding: "5px 14px",
  },
  footer: {
    textAlign: "center",
    fontSize: "11px",
    color: "#B0A89C",
    marginTop: "auto",
    paddingTop: "32px",
    letterSpacing: "0.3px",
  },
};

const globalCSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { -webkit-font-smoothing: antialiased; }
  input:focus { border-color: #E8734A !important; box-shadow: 0 0 0 3px rgba(232,115,74,0.12); }
  button:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(232,115,74,0.3) !important; }
  button:active { transform: translateY(0); }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes slideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes wordIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes flameFlicker { 0%, 100% { transform: scale(1) rotate(0deg); opacity: 1; } 50% { transform: scale(1.08) rotate(-2deg); opacity: 0.92; } }
  @keyframes confettiFall {
    0% { opacity: 1; transform: translateY(0) rotate(0deg); }
    100% { opacity: 0; transform: translateY(100vh) rotate(720deg); }
  }
`;
