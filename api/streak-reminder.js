// ============================================================
// SophiaLingo — Streak reminder (Vercel Cron → Ntfy push)
// ============================================================
// Triggered daily by Vercel Cron (see vercel.json). Reads the current streak
// state from the Apps Script backend (?action=getStreak) and pushes a short,
// contextual Ntfy notification to Sophia's phone. Stateless — all streak logic
// lives in Code.js; this function only decides what to say.
//
// Required env vars (Vercel → Settings → Environment Variables):
//   APPS_SCRIPT_URL  — the Apps Script /exec base (same URL as API_URL in SophiaLingo.jsx)
//   NTFY_TOPIC       — the Ntfy topic Sophia's app is subscribed to
//   CRON_SECRET      — random string; Vercel auto-sends it as a Bearer token on cron calls

const APP_URL = "https://sophialingo.vercel.app/";

export default async function handler(req, res) {
  // Lock the endpoint to Vercel's cron (which sends Authorization: Bearer <CRON_SECRET>).
  if (
    process.env.CRON_SECRET &&
    req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).end("Unauthorized");
  }

  const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
  const NTFY_TOPIC = process.env.NTFY_TOPIC;

  if (!APPS_SCRIPT_URL || !NTFY_TOPIC) {
    return res.status(500).json({ error: "APPS_SCRIPT_URL and NTFY_TOPIC must be set" });
  }

  // 1. Read current streak state.
  let s;
  try {
    const r = await fetch(`${APPS_SCRIPT_URL}?action=getStreak`);
    s = await r.json();
    if (s.error) throw new Error(s.error);
  } catch (err) {
    return res.status(502).json({ error: "getStreak failed: " + err.message });
  }

  // 2. Already practiced today → don't nag.
  if (s.sessions_today >= 1) {
    return res.status(200).json({ skipped: "practiced today", streak: s.streak });
  }

  // 3. Decide the message from state. (frozen/emotion come straight from getStreak.)
  let title, message, priority;
  if (s.frozen) {
    // Missed yesterday — a freeze is covering it. Today is the last chance.
    title = `🧊 ${s.streak} Tage in Gefahr`;
    message = "Heute üben, sonst ist die Serie weg! 🥶";
    priority = 5; // urgent
  } else if (s.streak >= 1) {
    // Streak intact from yesterday, not practiced yet today.
    title = `🔥 ${s.streak}`;
    message = s.emotion || "🙂";
    priority = 4; // high
  } else {
    // No active streak — gentle nudge to start one.
    title = "🔥 Neue Serie?";
    message = "Hol dir heute Tag 1.";
    priority = 3;
  }

  // 4. Publish to Ntfy via JSON (UTF-8 body → emoji in the title renders correctly).
  try {
    await fetch("https://ntfy.sh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: NTFY_TOPIC,
        title,
        message,
        priority,
        click: APP_URL,
        tags: s.frozen ? ["ice_cube"] : ["fire"],
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: "ntfy failed: " + err.message });
  }

  return res.status(200).json({ sent: true, streak: s.streak, frozen: s.frozen });
}
