// ============================================================
// SophiaLingo — Google Apps Script API
// ============================================================
// Deploy as: Web App → Execute as "Me" → Access "Anyone"
//
// Spreadsheet ID (update if you recreate the sheet):
const SHEET_ID = '1t0itr36VJnfjW8-qKa8-pesjXoS_bqkKjtIpvrwmEIM';
//
// Leitner box intervals (days)
const LEITNER_INTERVALS = {
  1: 1,
  2: 3,
  3: 7,
  4: 14,
  5: 30,
};

// ============================================================
// Entry points — GET and POST
// ============================================================

function doGet(e) {
  try {
    const action = (e.parameter.action || '').toLowerCase();
    let result;

    switch (action) {
      case 'getwords':
        result = getWords(e.parameter);
        break;
      case 'getstats':
        result = getStats();
        break;
      case 'getstreak':
        result = getStreak();
        break;
      case 'getsentences':
        result = getSentences();
        break;
      case 'ping':
        result = { ok: true, timestamp: new Date().toISOString() };
        break;
      default:
        result = { error: 'Unknown action. Use: getWords, getStats, getStreak, ping' };
    }

    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err.message, stack: err.stack });
  }
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const action = (body.action || '').toLowerCase();
  let result;

  switch (action) {
    case 'updateword':
      result = updateWord(body);
      break;
    case 'addwords':
      result = addWords(body);
      break;
    case 'logsession':
      result = logSession(body);
      break;
    case 'editword':
      result = editWord(body);
      break;
    case 'evalsentence':
      result = evalSentence(body);
      break;
    default:
      result = { error: 'Unknown action. Use: updateWord, addWords, logSession, editWord, evalSentence' };
  }

  return jsonResponse(result);
}

// ============================================================
// CORS-friendly JSON response
// ============================================================

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// getWords — fetch due words for today's quiz
// ============================================================
// GET ?action=getWords&limit=10
// Group A (active due): last_reviewed != '' AND next_review <= today, sorted next_review ASC then last_reviewed ASC.
// Group B (new): last_reviewed == '' (never reviewed), appended in sheet row order.
// Limited to `limit`.

function getWords(params) {
  const limit = parseInt(params.limit) || 10;
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('SophiaLingo Database');

  if (!sheet) {
    return { error: 'Sheet "SophiaLingo Database" not found' };
  }

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const tz = Session.getScriptTimeZone();
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  const words = [];

  for (let i = 1; i < data.length; i++) {
    const row = rowToObject(headers, data[i], i + 1);

    // Parse next_review as a comparable string (timezone-safe)
    let nextReviewStr;
    if (row.next_review instanceof Date) {
      nextReviewStr = Utilities.formatDate(row.next_review, tz, 'yyyy-MM-dd');
    } else if (row.next_review) {
      nextReviewStr = String(row.next_review).substring(0, 10);
    } else {
      nextReviewStr = '1970-01-01';
    }

    // Parse last_reviewed as a comparable string (timezone-safe); blank = never reviewed
    let lastReviewedStr;
    if (row.last_reviewed instanceof Date) {
      lastReviewedStr = Utilities.formatDate(row.last_reviewed, tz, 'yyyy-MM-dd');
    } else if (row.last_reviewed) {
      lastReviewedStr = String(row.last_reviewed).substring(0, 10);
    } else {
      lastReviewedStr = '';
    }

    const isNew = !lastReviewedStr;          // never reviewed — eligible as filler
    const isActiveDue = !isNew && nextReviewStr <= todayStr;

    if (isActiveDue || isNew) {
      row._rowIndex = i + 1;
      row.leitner_box = parseInt(row.leitner_box) || 1;
      row.nextReviewStr = nextReviewStr;
      row.lastReviewedStr = lastReviewedStr;
      words.push(row);
    }
  }

  // Active due words first (most overdue → oldest reviewed), new words last in sheet row order
  words.sort((a, b) => {
    const aNew = !a.lastReviewedStr;
    const bNew = !b.lastReviewedStr;
    if (aNew !== bNew) return aNew ? 1 : -1;
    if (aNew && bNew) return 0;
    if (a.nextReviewStr !== b.nextReviewStr)
      return a.nextReviewStr.localeCompare(b.nextReviewStr);
    return a.lastReviewedStr.localeCompare(b.lastReviewedStr);
  });

  const selected = words.slice(0, limit);

  return {
    words: selected,
    total_due: words.length,
    returned: selected.length,
    date: todayStr,
  };
}

// ============================================================
// updateWord — update a single word after quiz answer
// ============================================================
// POST { action: "updateWord", word_id: "w_001", correct: true }
//
// If correct: leitner_box + 1 (max 5), next_review = today + interval
// If wrong:   leitner_box = 1, next_review = tomorrow

function updateWord(body) {
  const wordId = body.word_id;
  const correct = body.correct === true;

  if (!wordId) {
    return { error: 'word_id is required' };
  }

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('SophiaLingo Database');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  // Find column indices
  const cols = {};
  headers.forEach((h, idx) => { cols[h] = idx; });

  // Find the word row
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][cols['word_id']] === wordId) {
      rowIndex = i;
      break;
    }
  }

  if (rowIndex === -1) {
    return { error: 'Word not found: ' + wordId };
  }

  const currentBox = parseInt(data[rowIndex][cols['leitner_box']]) || 1;
  const timesCorrect = parseInt(data[rowIndex][cols['times_correct']]) || 0;
  const timesWrong = parseInt(data[rowIndex][cols['times_wrong']]) || 0;

  let newBox, newNextReview;
  const tz = Session.getScriptTimeZone();
  const today = new Date();
  const todayStr = Utilities.formatDate(today, tz, 'yyyy-MM-dd');

  if (correct) {
    newBox = Math.min(currentBox + 1, 5);
    const interval = LEITNER_INTERVALS[newBox];
    newNextReview = new Date(today);
    newNextReview.setDate(newNextReview.getDate() + interval);

    // Update times_correct
    sheet.getRange(rowIndex + 1, cols['times_correct'] + 1).setValue(timesCorrect + 1);
  } else {
    newBox = 1;
    newNextReview = new Date(today);
    newNextReview.setDate(newNextReview.getDate() + 1);

    // Update times_wrong
    sheet.getRange(rowIndex + 1, cols['times_wrong'] + 1).setValue(timesWrong + 1);
  }

  const nextReviewStr = Utilities.formatDate(newNextReview, tz, 'yyyy-MM-dd');

  // Update leitner_box
  sheet.getRange(rowIndex + 1, cols['leitner_box'] + 1).setValue(newBox);

  // Update next_review (as YYYY-MM-DD string, timezone-safe)
  sheet.getRange(rowIndex + 1, cols['next_review'] + 1).setValue(nextReviewStr);

  // Update last_reviewed (timezone-safe)
  sheet.getRange(rowIndex + 1, cols['last_reviewed'] + 1).setValue(todayStr);

  return {
    word_id: wordId,
    correct: correct,
    old_box: currentBox,
    new_box: newBox,
    next_review: nextReviewStr,
  };
}

// ============================================================
// addWords — bulk add new word pairs
// ============================================================
// POST { action: "addWords", words: [
//   { source_word: "hola", target_word: "hallo" },
//   ...
// ], source_lang: "es", target_lang: "de", source: "photo" }

function addWords(body) {
  const newWords = body.words;
  const sourceLang = body.source_lang || 'es';
  const targetLang = body.target_lang || 'de';
  const addSource = body.source || 'manual';

  if (!newWords || !Array.isArray(newWords) || newWords.length === 0) {
    return { error: 'words array is required' };
  }

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('SophiaLingo Database');
  const data = sheet.getDataRange().getValues();

  // Find the highest existing word_id number
  let maxId = 0;
  for (let i = 1; i < data.length; i++) {
    const wid = data[i][0]; // word_id column
    if (typeof wid === 'string' && wid.startsWith('w_')) {
      const num = parseInt(wid.replace('w_', ''));
      if (num > maxId) maxId = num;
    }
  }

  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const rowsToAdd = [];
  const addedWords = [];

  newWords.forEach((w, idx) => {
    if (!w.source_word || !w.target_word) return;

    const wordId = 'w_' + String(maxId + idx + 1).padStart(3, '0');
    const row = [
      wordId,
      sourceLang,
      targetLang,
      w.source_word.trim(),
      w.target_word.trim(),
      1,            // leitner_box
      today,        // next_review (due today)
      '',           // last_reviewed
      0,            // times_correct
      0,            // times_wrong
      today,        // date_added
      addSource,    // source
      w.example_sentence  ? w.example_sentence.trim()  : '',  // example_sentence
      '',                                                       // sentence_eval
      w.example_sentence_2 ? w.example_sentence_2.trim() : '', // example_sentence_2
      '',                                                       // sentence_eval_2
      w.example_sentence_3 ? w.example_sentence_3.trim() : '', // example_sentence_3
      '',                                                       // sentence_eval_3
    ];
    rowsToAdd.push(row);
    addedWords.push({ word_id: wordId, source_word: w.source_word, target_word: w.target_word });
  });

  if (rowsToAdd.length > 0) {
    sheet.getRange(
      data.length + 1,    // start after last row
      1,                   // column A
      rowsToAdd.length,    // number of rows
      rowsToAdd[0].length  // number of columns
    ).setValues(rowsToAdd);
  }

  return {
    added: addedWords.length,
    words: addedWords,
  };
}

// ============================================================
// logSession — record a completed quiz session
// ============================================================
// POST { action: "logSession", words_tested: 10, correct: 7 }
//
// Creates/uses a "Sessions" sheet.

function logSession(body) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sessionsSheet = ss.getSheetByName('Sessions');

  // Auto-create Sessions sheet if it doesn't exist
  if (!sessionsSheet) {
    sessionsSheet = ss.insertSheet('Sessions');
    sessionsSheet.appendRow([
      'session_id', 'date', 'words_tested', 'correct', 'score_pct', 'completed'
    ]);
  }

  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const wordsTested = parseInt(body.words_tested) || 0;
  const correct = parseInt(body.correct) || 0;
  const scorePct = wordsTested > 0 ? Math.round((correct / wordsTested) * 100) : 0;
  const sessionId = 's_' + today.replace(/-/g, '');

  sessionsSheet.appendRow([
    sessionId,
    today,
    wordsTested,
    correct,
    scorePct + '%',
    true,
  ]);

  return {
    session_id: sessionId,
    date: today,
    words_tested: wordsTested,
    correct: correct,
    score_pct: scorePct,
  };
}

// ============================================================
// editWord — correct source_word or target_word in the sheet
// ============================================================
// POST { action: "editWord", word_id: "w_001",
//        source_word: "..." | target_word: "..." }

function editWord(body) {
  const wordId = body.word_id;
  if (!wordId) return { error: 'word_id is required' };

  const hasSource    = typeof body.source_word        === 'string' && body.source_word.trim()        !== '';
  const hasTarget    = typeof body.target_word        === 'string' && body.target_word.trim()        !== '';
  const hasSentence  = typeof body.example_sentence   === 'string';
  const hasSentence2 = typeof body.example_sentence_2 === 'string';
  const hasSentence3 = typeof body.example_sentence_3 === 'string';
  const hasEval      = typeof body.sentence_eval      === 'string' && ['up', 'down', ''].includes(body.sentence_eval);
  const hasEval2     = typeof body.sentence_eval_2    === 'string' && ['up', 'down', ''].includes(body.sentence_eval_2);
  const hasEval3     = typeof body.sentence_eval_3    === 'string' && ['up', 'down', ''].includes(body.sentence_eval_3);

  if (!hasSource && !hasTarget && !hasSentence && !hasSentence2 && !hasSentence3 && !hasEval && !hasEval2 && !hasEval3) {
    return { error: 'At least one updatable field is required' };
  }

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('SophiaLingo Database');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const cols = {};
  headers.forEach((h, idx) => { cols[h] = idx; });

  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][cols['word_id']] === wordId) { rowIndex = i; break; }
  }
  if (rowIndex === -1) return { error: 'Word not found: ' + wordId };

  const updated = {};

  if (hasSource) {
    sheet.getRange(rowIndex + 1, cols['source_word'] + 1).setValue(body.source_word.trim());
    updated.source_word = body.source_word.trim();
  }
  if (hasTarget) {
    sheet.getRange(rowIndex + 1, cols['target_word'] + 1).setValue(body.target_word.trim());
    updated.target_word = body.target_word.trim();
  }
  if (hasSentence) {
    sheet.getRange(rowIndex + 1, cols['example_sentence'] + 1).setValue(body.example_sentence.trim());
    updated.example_sentence = body.example_sentence.trim();
  }
  if (hasEval) {
    sheet.getRange(rowIndex + 1, cols['sentence_eval'] + 1).setValue(body.sentence_eval);
    updated.sentence_eval = body.sentence_eval;
  }
  if (hasSentence2) {
    sheet.getRange(rowIndex + 1, cols['example_sentence_2'] + 1).setValue(body.example_sentence_2.trim());
    updated.example_sentence_2 = body.example_sentence_2.trim();
  }
  if (hasEval2) {
    sheet.getRange(rowIndex + 1, cols['sentence_eval_2'] + 1).setValue(body.sentence_eval_2);
    updated.sentence_eval_2 = body.sentence_eval_2;
  }
  if (hasSentence3) {
    sheet.getRange(rowIndex + 1, cols['example_sentence_3'] + 1).setValue(body.example_sentence_3.trim());
    updated.example_sentence_3 = body.example_sentence_3.trim();
  }
  if (hasEval3) {
    sheet.getRange(rowIndex + 1, cols['sentence_eval_3'] + 1).setValue(body.sentence_eval_3);
    updated.sentence_eval_3 = body.sentence_eval_3;
  }

  return { word_id: wordId, updated };
}

// ============================================================
// evalSentence — save user thumbs-up / thumbs-down on a sentence
// ============================================================
// POST { action: "evalSentence", word_id: "w_001", eval: "up" | "down" | "" }

function evalSentence(body) {
  const wordId = body.word_id;
  if (!wordId) return { error: 'word_id is required' };

  const evalValue = typeof body.eval === 'string' ? body.eval.trim() : '';
  if (!['up', 'down', ''].includes(evalValue)) {
    return { error: 'eval must be "up", "down", or ""' };
  }

  const slot = parseInt(body.slot) || 1;
  if (![1, 2, 3].includes(slot)) {
    return { error: 'slot must be 1, 2, or 3' };
  }
  const colName = slot === 1 ? 'sentence_eval' : 'sentence_eval_' + slot;

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('SophiaLingo Database');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const cols = {};
  headers.forEach((h, idx) => { cols[h] = idx; });

  if (cols[colName] === undefined) {
    return { error: colName + ' column not found in sheet' };
  }

  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][cols['word_id']] === wordId) { rowIndex = i; break; }
  }
  if (rowIndex === -1) return { error: 'Word not found: ' + wordId };

  sheet.getRange(rowIndex + 1, cols[colName] + 1).setValue(evalValue);

  return { word_id: wordId, slot: slot, sentence_eval: evalValue };
}

// ============================================================
// getStats — get overview statistics
// ============================================================
// GET ?action=getStats

function getStats() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('SophiaLingo Database');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const cols = {};
  headers.forEach((h, idx) => { cols[h] = idx; });

  const tz = Session.getScriptTimeZone();
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  let totalWords = 0;
  let dueToday = 0;
  const boxCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let totalCorrect = 0;
  let totalWrong = 0;
  let reviewedToday = 0;

  for (let i = 1; i < data.length; i++) {
    totalWords++;

    const box = parseInt(data[i][cols['leitner_box']]) || 1;
    boxCounts[box] = (boxCounts[box] || 0) + 1;

    totalCorrect += parseInt(data[i][cols['times_correct']]) || 0;
    totalWrong += parseInt(data[i][cols['times_wrong']]) || 0;

    // Check if due today (timezone-safe)
    let nextReview = data[i][cols['next_review']];
    let nextReviewStr;
    if (nextReview instanceof Date) {
      nextReviewStr = Utilities.formatDate(nextReview, tz, 'yyyy-MM-dd');
    } else if (nextReview) {
      nextReviewStr = String(nextReview).substring(0, 10);
    } else {
      nextReviewStr = '1970-01-01';
    }
    if (nextReviewStr <= todayStr) dueToday++;

    // Check if reviewed today (timezone-safe)
    let lastReviewed = data[i][cols['last_reviewed']];
    let lastReviewedStr;
    if (lastReviewed instanceof Date) {
      lastReviewedStr = Utilities.formatDate(lastReviewed, tz, 'yyyy-MM-dd');
    } else if (lastReviewed) {
      lastReviewedStr = String(lastReviewed).substring(0, 10);
    } else {
      lastReviewedStr = '';
    }
    if (lastReviewedStr === todayStr) reviewedToday++;
  }

  return {
    total_words: totalWords,
    due_today: dueToday,
    reviewed_today: reviewedToday,
    completed_today: reviewedToday > 0,
    box_distribution: boxCounts,
    lifetime_correct: totalCorrect,
    lifetime_wrong: totalWrong,
    lifetime_accuracy: (totalCorrect + totalWrong) > 0
      ? Math.round((totalCorrect / (totalCorrect + totalWrong)) * 100)
      : 0,
  };
}

// ============================================================
// getStreak — derive current streak + freeze state from Sessions
// ============================================================
// GET ?action=getStreak
//
// Read-only. Replays the Sessions sheet (one row per completed round;
// session_id is per-day, so rounds-per-day = number of rows sharing a date).
//
// Rules:
//   - A "streak day" = >=1 round completed that calendar day.
//   - Earning a freeze: >=3 rounds in a single day earns 1 freeze (max 1, no stacking).
//   - A freeze auto-covers exactly one missed day; a second consecutive miss breaks the streak.
//   - Today is handled separately: an unpracticed today must NOT break or consume a freeze.
//
// Returns: { streak, frozen, freezes, sessions_today, longest, emotion, today }

function getStreak() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Sessions');
  const tz = Session.getScriptTimeZone();
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  // No Sessions sheet yet (fresh install) — read-only, do not create it.
  if (!sheet) return zeroStreak(todayStr);

  const data = sheet.getDataRange().getValues();

  // Count rounds per calendar day (skip header row 0).
  const dayCount = {};
  for (let i = 1; i < data.length; i++) {
    const d = normalizeDate(data[i][1], tz); // column 1 = date
    if (!d) continue;
    dayCount[d] = (dayCount[d] || 0) + 1;
  }

  const keys = Object.keys(dayCount).sort();
  if (keys.length === 0) return zeroStreak(todayStr);

  let streak = 0;
  let freezes = 0;
  let frozen = false;
  let longest = 0;

  // Replay every calendar day from the first practice day up to (not incl.) today.
  const cursor = noonDateFromStr(keys[0]);
  while (Utilities.formatDate(cursor, tz, 'yyyy-MM-dd') < todayStr) {
    const key = Utilities.formatDate(cursor, tz, 'yyyy-MM-dd');
    const rounds = dayCount[key] || 0;
    if (rounds >= 1) {
      streak++;
      frozen = false;
      if (rounds >= 3 && freezes < 1) freezes = 1;
      if (streak > longest) longest = streak;
    } else {
      if (freezes >= 1) { freezes--; frozen = true; }
      else { streak = 0; frozen = false; }
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  // Today (not over yet): only practicing today changes state.
  const todaySessions = dayCount[todayStr] || 0;
  if (todaySessions >= 1) {
    streak++;
    frozen = false;
    if (todaySessions >= 3 && freezes < 1) freezes = 1;
    if (streak > longest) longest = streak;
  }
  if (streak > longest) longest = streak; // defensive

  const displayFrozen = frozen && todaySessions === 0;

  return {
    streak: streak,
    frozen: displayFrozen,
    freezes: freezes,
    sessions_today: todaySessions,
    longest: longest,
    emotion: emotionFor(streak, displayFrozen),
    today: todayStr,
  };
}

function zeroStreak(todayStr) {
  return {
    streak: 0,
    frozen: false,
    freezes: 0,
    sessions_today: 0,
    longest: 0,
    emotion: emotionFor(0, false),
    today: todayStr,
  };
}

// Streak-length → emotion emoji. Emoji is data so the notification cron gets it
// for free; German UI text stays on the frontend.
function emotionFor(streak, frozen) {
  if (frozen) return '🥶';
  if (streak <= 0) return '';
  if (streak === 1) return '😐';
  if (streak <= 3) return '🙂';
  if (streak <= 6) return '😊';
  if (streak <= 13) return '🤠';
  if (streak <= 29) return '😄';
  if (streak <= 59) return '😆';
  if (streak <= 99) return '🤩';
  return '⭐';
}

// ============================================================
// getSentences — return all words that have an example sentence
// ============================================================
// GET ?action=getSentences
// Returns every word with a non-empty example_sentence, including
// the sentence_eval field so callers can filter up/down/unrated.

function getSentences() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('SophiaLingo Database');
  if (!sheet) return { error: 'Sheet "SophiaLingo Database" not found' };

  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const words = [];
  for (let i = 1; i < data.length; i++) {
    const row = rowToObject(headers, data[i], i + 1);
    if (!row.example_sentence) continue;
    words.push({
      word_id: row.word_id,
      source_word: row.source_word,
      target_word: row.target_word,
      example_sentence:   row.example_sentence   || '',
      sentence_eval:      row.sentence_eval      || '',
      example_sentence_2: row.example_sentence_2 || '',
      sentence_eval_2:    row.sentence_eval_2    || '',
      example_sentence_3: row.example_sentence_3 || '',
      sentence_eval_3:    row.sentence_eval_3    || '',
      leitner_box: parseInt(row.leitner_box) || 1,
      times_correct: parseInt(row.times_correct) || 0,
      times_wrong: parseInt(row.times_wrong) || 0,
    });
  }

  return { words, total: words.length };
}

// ============================================================
// Helpers
// ============================================================

// Normalize a sheet date cell to 'yyyy-MM-dd' (cells may be Date or string);
// returns '' for blank. Mirrors the date handling in getWords/getStats.
function normalizeDate(cell, tz) {
  if (cell instanceof Date) return Utilities.formatDate(cell, tz, 'yyyy-MM-dd');
  if (cell) return String(cell).substring(0, 10);
  return '';
}

// Build a Date anchored at noon local time from a 'yyyy-MM-dd' string, so
// stepping day-by-day with setDate never drifts across a DST boundary.
function noonDateFromStr(s) {
  const parts = s.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
}

function rowToObject(headers, row, rowIndex) {
  const obj = {};
  headers.forEach((h, idx) => {
    obj[h] = row[idx];
  });
  obj._rowIndex = rowIndex;
  return obj;
}

function testAuth() {
  const sheet = SpreadsheetApp.openById('1t0itr36VJnfjW8-qKa8-pesjXoS_bqkKjtIpvrwmEIM');
  const name = sheet.getName();
  Logger.log('Connected: ' + name);
}
