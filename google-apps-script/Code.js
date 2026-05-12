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
  const action = (e.parameter.action || '').toLowerCase();
  let result;

  switch (action) {
    case 'getwords':
      result = getWords(e.parameter);
      break;
    case 'getstats':
      result = getStats();
      break;
    case 'ping':
      result = { ok: true, timestamp: new Date().toISOString() };
      break;
    default:
      result = { error: 'Unknown action. Use: getWords, getStats, ping' };
  }

  return jsonResponse(result);
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
    default:
      result = { error: 'Unknown action. Use: updateWord, addWords, logSession, editWord' };
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
// Returns words where next_review <= today, sorted by
// leitner_box ASC (hardest first), limited to `limit`.

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

    if (nextReviewStr <= todayStr) {
      row._rowIndex = i + 1;
      row.leitner_box = parseInt(row.leitner_box) || 1;
      words.push(row);
    }
  }

  // Sort by leitner_box ascending (box 1 = least known, show first)
  words.sort((a, b) => a.leitner_box - b.leitner_box);

  // Limit
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
      w.example_sentence ? w.example_sentence.trim() : '',
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

  const hasSource = typeof body.source_word === 'string' && body.source_word.trim() !== '';
  const hasTarget = typeof body.target_word === 'string' && body.target_word.trim() !== '';
  if (!hasSource && !hasTarget) return { error: 'source_word or target_word is required' };

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

  if (hasSource) {
    sheet.getRange(rowIndex + 1, cols['source_word'] + 1).setValue(body.source_word.trim());
  }
  if (hasTarget) {
    sheet.getRange(rowIndex + 1, cols['target_word'] + 1).setValue(body.target_word.trim());
  }

  return {
    word_id: wordId,
    updated: {
      ...(hasSource ? { source_word: body.source_word.trim() } : {}),
      ...(hasTarget ? { target_word: body.target_word.trim() } : {}),
    },
  };
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
// Helpers
// ============================================================

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
