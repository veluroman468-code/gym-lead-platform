import { useState, useEffect, useRef, useCallback } from "react";
import {
  Brain, Lock, Sparkles, Dumbbell, Droplet, Flame, TrendingUp, Star,
  Phone, MessageCircle, Mail, CheckCircle2, ArrowRight, ArrowLeft,
  Loader2, Zap, Users, FileText, Target, Moon, Activity, Wallet,
  LayoutDashboard, Calendar, BarChart3, Settings as SettingsIcon,
  UserCircle, LogOut, Eye, EyeOff, AlertCircle, Search, ChevronRight, X,
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

/* ============================================================
   CONFIG — Supabase + Gym contact
   ============================================================ */
// TODO: replace with your real Supabase project URL, e.g.
// "https://abcdefghijkl.supabase.co"
const SUPABASE_URL = "https://frdphpxwmsgzolvyzhto.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_hzSb4BOiAJ_-dUe0mvWjUQ_aa7b1LIj";
// TODO: replace with the gym's real WhatsApp number — digits only, country code first, no + or spaces
const GYM_WHATSAPP_NUMBER = "911234567890";
// TODO: paste your Google Apps Script Web App URL here once deployed
// (see google-apps-script.gs for the script + setup steps)
const SHEETS_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbwGUm7SBEav3MjPYU4KwOWvNfXIxFMKUuw-zp21OrVAKjCPS5-z70AgrK7stayMPPB_/exec";

function sheetsReady() {
  return !SHEETS_WEBHOOK_URL.includes("YOUR_SCRIPT_ID");
}

// Fire-and-forget push to a Google Sheet, so a non-technical gym owner can
// track leads without ever touching Supabase. Uses mode:"no-cors" and a
// text/plain content type because Apps Script Web Apps don't return proper
// CORS headers — this avoids a preflight request and just fires the write.
// We can't read a response back (the browser blocks it), so this never
// blocks the UI and never reports failure; Supabase remains the source of
// truth either way.
async function pushToSheet(payload) {
  if (!sheetsReady()) return;
  try {
    await fetch(SHEETS_WEBHOOK_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("Google Sheets push failed:", e);
  }
}

function supabaseReady() {
  return !SUPABASE_URL.includes("YOUR-PROJECT-REF");
}

// Generates the lead's id on the client so we can refer back to it later
// (e.g. to confirm a booking) without ever needing to SELECT leads back
// from Supabase — the anon key can INSERT but intentionally can't read,
// which is what keeps lead scores admin-only.
function genId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function insertLead(payload) {
  if (!supabaseReady()) {
    console.warn("Supabase URL not set — skipping real insert. Payload:", payload);
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.error("Supabase insert failed:", e);
    return { ok: false, error: String(e) };
  }
}

// Narrow, secure "booking" update: rather than granting the anon key
// UPDATE access on leads (which would then need locking to specific
// columns to stay safe), we call a Postgres RPC that only ever sets
// status + a slot note for one row. See book_consultation in the SQL file.
async function bookConsultation(leadId, slotLabel) {
  if (!supabaseReady() || !leadId) {
    console.warn("Supabase not ready or missing lead id — booking not persisted.");
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/book_consultation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ p_lead_id: leadId, p_slot: slotLabel }),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.error("Booking update failed:", e);
    return { ok: false, error: String(e) };
  }
}

// Admin login via Supabase Auth (password grant). The returned access
// token carries the "authenticated" role, which is what the leads
// table's SELECT policy checks for — this is the only way to read
// leads back, including lead_score, by design.
async function adminSignIn(email, password) {
  if (!supabaseReady()) return { ok: false, skipped: true };
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error_description || data.msg || "Invalid email or password." };
    return { ok: true, accessToken: data.access_token };
  } catch (e) {
    console.error("Admin sign-in failed:", e);
    return { ok: false, error: String(e) };
  }
}

async function fetchLeads(accessToken) {
  if (!supabaseReady()) return { ok: false, skipped: true, leads: [] };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/leads?select=*&order=created_at.desc&limit=500`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { ok: false, leads: [] };
    const leads = await res.json();
    return { ok: true, leads };
  } catch (e) {
    console.error("Fetching leads failed:", e);
    return { ok: false, error: String(e), leads: [] };
  }
}

// Generic authenticated update (status changes, notes) — allowed by the
// "Authenticated users can update leads" policy in supabase-schema.sql.
// Skips the network call entirely for sample/mock leads.
async function patchLead(accessToken, leadId, patch) {
  if (!supabaseReady() || !leadId || String(leadId).startsWith("mock-")) {
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${leadId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(patch),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.error("Updating lead failed:", e);
    return { ok: false, error: String(e) };
  }
}

async function fetchProfile(accessToken) {
  if (!supabaseReady()) return { ok: false, skipped: true, profile: null };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/gym_profile?id=eq.1&select=*`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { ok: false, profile: null };
    const rows = await res.json();
    return { ok: true, profile: rows[0] || null };
  } catch (e) {
    console.error("Fetching gym profile failed:", e);
    return { ok: false, error: String(e), profile: null };
  }
}

async function saveProfile(accessToken, patch) {
  if (!supabaseReady()) return { ok: false, skipped: true };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/gym_profile?id=eq.1`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(patch),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.error("Saving gym profile failed:", e);
    return { ok: false, error: String(e) };
  }
}

/* ============================================================
   DESIGN TOKENS
   ============================================================ */
const PRIMARY = "#C8F135";
const PRIMARY_DIM = "#8FB020";
const DARK = "#0A0A0A";
const CARD = "#141414";
const GLASS = "rgba(255,255,255,0.04)";
const BORDER = "rgba(255,255,255,0.08)";
const MUTED = "#1E1E1E";
const TEXT = "#F2F2F0";
const SUBTEXT = "#8A8A8A";
const AI_GLOW = "#8B7CFF";

const gymName = "PowerFit Gym";

const S = {
  app: { minHeight: "100vh", background: DARK, color: TEXT, fontFamily: "'Inter',sans-serif", position: "relative", overflowX: "hidden" },
  display: { fontFamily: "'Space Grotesk',sans-serif" },
  header: { width: "100%", padding: "18px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${BORDER}`, boxSizing: "border-box", position: "relative", zIndex: 5, backdropFilter: "blur(10px)" },
  logo: { fontWeight: 800, fontSize: "18px", letterSpacing: "-0.5px", color: TEXT, fontFamily: "'Space Grotesk',sans-serif" },
  badge: { background: GLASS, border: `1px solid ${BORDER}`, borderRadius: "20px", padding: "5px 14px", fontSize: "12px", color: SUBTEXT, fontWeight: 500 },
  page: { width: "100%", maxWidth: 480, padding: "40px 24px 80px", margin: "0 auto", position: "relative", zIndex: 2 },
  stepLabel: { fontSize: "11px", fontWeight: 700, letterSpacing: "2px", color: PRIMARY, textTransform: "uppercase", marginBottom: "10px" },
  h1: { fontSize: "34px", fontWeight: 700, lineHeight: 1.08, letterSpacing: "-1px", margin: "0 0 10px", fontFamily: "'Space Grotesk',sans-serif" },
  sub: { fontSize: "14px", color: SUBTEXT, marginBottom: "28px", lineHeight: 1.6 },
  card: { background: CARD, border: `1px solid ${BORDER}`, borderRadius: "18px", padding: "22px", marginBottom: "14px" },
  label: { display: "block", fontSize: "12px", fontWeight: 600, color: SUBTEXT, marginBottom: "6px" },
  input: { width: "100%", background: MUTED, border: "1px solid #2c2c2c", borderRadius: "10px", padding: "12px 14px", color: TEXT, fontSize: "14px", outline: "none", boxSizing: "border-box", marginBottom: "6px", fontFamily: "inherit" },
  errorText: { fontSize: "11px", color: "#FF6B6B", marginBottom: "10px", marginTop: "-2px" },
  btnP: { width: "100%", background: PRIMARY, color: DARK, border: "none", borderRadius: "12px", padding: "15px", fontSize: "14px", fontWeight: 800, cursor: "pointer", marginTop: "6px", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", transition: "transform .15s" },
  btnS: { width: "100%", background: "transparent", color: SUBTEXT, border: `1px solid ${BORDER}`, borderRadius: "12px", padding: "12px", fontSize: "13px", fontWeight: 600, cursor: "pointer", marginTop: "8px", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" },
  pillRow: { display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "16px" },
  pill: (a) => ({ padding: "9px 16px", borderRadius: "30px", border: a ? `2px solid ${PRIMARY}` : `2px solid ${BORDER}`, background: a ? `${PRIMARY}18` : "transparent", color: a ? PRIMARY : SUBTEXT, cursor: "pointer", fontSize: "12.5px", fontWeight: 600, transition: "all .15s" }),
  progressWrap: { display: "flex", gap: 6, marginBottom: 24 },
  progressSeg: (done) => ({ height: 4, flex: 1, borderRadius: 4, background: done ? PRIMARY : BORDER, transition: "background .3s" }),
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 },
  modalCard: { width: "100%", maxWidth: 380, background: CARD, border: `1px solid ${BORDER}`, borderRadius: 18, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" },
};

/* ============================================================
   PARTICLE / GRADIENT BACKGROUND
   ============================================================ */
function Background() {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: "-10%", left: "-10%", width: "60%", height: "50%", background: `radial-gradient(circle,${PRIMARY}14 0%,transparent 70%)`, filter: "blur(40px)" }} />
      <div style={{ position: "absolute", bottom: "-15%", right: "-10%", width: "55%", height: "50%", background: `radial-gradient(circle,${AI_GLOW}12 0%,transparent 70%)`, filter: "blur(50px)" }} />
      {Array.from({ length: 18 }).map((_, i) => (
        <span key={i} style={{
          position: "absolute",
          left: `${(i * 37) % 100}%`,
          top: `${(i * 53) % 100}%`,
          width: 3, height: 3, borderRadius: "50%",
          background: i % 3 === 0 ? PRIMARY : "#444",
          opacity: 0.5,
          animation: `floaty ${6 + (i % 5)}s ease-in-out ${i * 0.3}s infinite`,
        }} />
      ))}
    </div>
  );
}

/* ============================================================
   SMALL UI HELPERS
   ============================================================ */
function ProgressBar({ step, total = 4 }) {
  return (
    <div style={S.progressWrap}>
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} style={S.progressSeg(i < step)} />
      ))}
    </div>
  );
}

function CircularStat({ value, max = 100, size = 132, stroke = 10, color = PRIMARY, label, sub }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value / max));
  return (
    <div style={{ position: "relative", width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke={BORDER} strokeWidth={stroke} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 1.2s cubic-bezier(.22,1,.36,1)" }} />
      </svg>
      <div style={{ position: "absolute", textAlign: "center" }}>
        <div style={{ fontSize: size * 0.26, fontWeight: 800, fontFamily: "'Space Grotesk',sans-serif", color: TEXT }}>{Math.round(value)}</div>
        {label && <div style={{ fontSize: 10, color: SUBTEXT, fontWeight: 600, letterSpacing: 0.5 }}>{label}</div>}
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, value, label, accent }) {
  return (
    <div style={{ background: "#0d0d0d", borderRadius: 12, padding: "12px 14px", flex: "1 1 100px", border: `1px solid ${BORDER}` }}>
      <Icon size={15} color={accent || PRIMARY} style={{ marginBottom: 6 }} />
      <div style={{ fontSize: 17, fontWeight: 800, fontFamily: "'Space Grotesk',sans-serif" }}>{value}</div>
      <div style={{ fontSize: 10.5, color: SUBTEXT, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function LockedCard({ icon: Icon, title, blurb }) {
  return (
    <div style={{ position: "relative", borderRadius: 14, overflow: "hidden", marginBottom: 12, border: `1px solid ${BORDER}` }}>
      <div style={{ filter: "blur(5px)", opacity: 0.5, padding: 16, background: CARD }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <Icon size={16} color={PRIMARY} />
          <strong style={{ fontSize: 13 }}>{title}</strong>
        </div>
        <div style={{ fontSize: 12, color: SUBTEXT, lineHeight: 1.6 }}>{blurb}</div>
      </div>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(10,10,10,0.35)" }}>
        <Lock size={18} color={PRIMARY} />
      </div>
    </div>
  );
}

/* ============================================================
   FITNESS MATH
   ============================================================ */
function computeReport(data) {
  const h = parseFloat(data.height) || 170;
  const w = parseFloat(data.weight) || 70;
  const age = parseInt(data.age) || 28;
  const gender = data.gender || "Male";
  const bmi = +(w / Math.pow(h / 100, 2)).toFixed(1);

  let bmiCategory = "Normal";
  if (bmi < 18.5) bmiCategory = "Underweight";
  else if (bmi < 25) bmiCategory = "Normal";
  else if (bmi < 30) bmiCategory = "Overweight";
  else bmiCategory = "Obese";

  const bmr = gender === "Female"
    ? 10 * w + 6.25 * h - 5 * age - 161
    : 10 * w + 6.25 * h - 5 * age + 5;

  const days = parseInt(data.workoutDays) || 3;
  const activityMult = days <= 1 ? 1.2 : days <= 3 ? 1.375 : days <= 5 ? 1.55 : 1.725;
  let calories = bmr * activityMult;
  if (data.goal === "Lose Fat") calories *= 0.82;
  if (data.goal === "Weight Gain") calories *= 1.15;
  calories = Math.round(calories / 10) * 10;

  const proteinMult = data.goal === "Build Muscle" ? 2.0 : data.goal === "Lose Fat" ? 1.9 : 1.6;
  const protein = Math.round(w * proteinMult);
  const water = +(w * 0.033).toFixed(1);

  let bodyScore = 72;
  if (bmiCategory === "Normal") bodyScore += 12;
  if (bmiCategory === "Overweight") bodyScore -= 6;
  if (bmiCategory === "Obese") bodyScore -= 14;
  bodyScore += Math.min(days, 6) * 2;
  if (data.sleep === "7-8 hrs" || data.sleep === "8+ hrs") bodyScore += 4;
  if (data.stress === "Low") bodyScore += 3;
  if (data.stress === "High") bodyScore -= 4;
  bodyScore = Math.max(38, Math.min(97, Math.round(bodyScore)));

  return { bmi, bmiCategory, calories, protein, water, bodyScore };
}

function computeLeadScore(data, report) {
  let score = 45;
  const reasons = [];

  if (data.joiningTime === "Today") { score += 20; reasons.push("Ready to join immediately"); }
  else if (data.joiningTime === "This Week") { score += 12; reasons.push("Planning to join this week"); }
  else if (data.joiningTime === "This Month") { score += 5; reasons.push("Considering joining this month"); }

  if (data.budget === "₹3000+") { score += 15; reasons.push("Budget available for premium plan"); }
  else if (data.budget === "₹1500-3000") { score += 9; reasons.push("Mid-range budget confirmed"); }
  else { score += 3; }

  if (report.bmiCategory === "Overweight" || report.bmiCategory === "Obese") { score += 8; reasons.push("Clear transformation need"); }

  if (data.experience === "Beginner") { score += 5; reasons.push("Beginner — high guidance need"); }

  const days = parseInt(data.workoutDays) || 0;
  if (days >= 4) { score += 7; reasons.push("High weekly commitment"); }

  if (data.goal) reasons.push(`Motivated by clear goal: ${data.goal}`);

  score = Math.max(10, Math.min(99, Math.round(score)));
  return { score, reasons };
}

/* ============================================================
   PLAN GENERATOR — the real content, unlocked after booking
   ============================================================ */
// Deterministic pseudo-random index — same lead always gets the same
// pick (no flicker on re-render), different leads get real variety.
// FNV-1a + avalanche finalizer: needed because a plain multiplicative
// hash has weak low-order bits, which showed up as collisions on
// small mod values (like the 2-variant diet picker below).
function seededIndex(seed, mod) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return Math.abs(h) % mod;
}

function workoutDaysCount(val) {
  if (val === "1-2") return 2;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const EXERCISE_POOL = {
  "Full Body": [
    "Squats 3x12 · Push-ups 3x12 · Bent-over Rows 3x12 · Plank 3x40s",
    "Deadlifts 3x10 · Overhead Press 3x10 · Lat Pulldown 3x12 · Bicycle Crunches 3x20",
    "Lunges 3x12 · Dumbbell Bench Press 3x12 · Seated Rows 3x12 · Side Plank 2x30s",
  ],
  Push: [
    "Bench Press 4x8 · Incline DB Press 3x10 · Overhead Press 3x10 · Tricep Dips 3x12",
    "DB Shoulder Press 4x10 · Chest Fly 3x12 · Lateral Raises 3x15 · Skull Crushers 3x12",
  ],
  Pull: [
    "Pull-ups 4x8 · Barbell Rows 3x10 · Face Pulls 3x15 · Bicep Curls 3x12",
    "Lat Pulldown 4x10 · Seated Cable Rows 3x12 · Rear Delt Fly 3x15 · Hammer Curls 3x12",
  ],
  Legs: [
    "Squats 4x8 · Romanian Deadlifts 3x10 · Leg Press 3x12 · Calf Raises 3x20",
    "Bulgarian Split Squats 3x10 · Leg Curls 3x12 · Walking Lunges 3x12 · Calf Raises 3x20",
  ],
  Upper: [
    "Bench Press 3x10 · Barbell Rows 3x10 · Overhead Press 3x10 · Bicep Curls 3x12",
    "Incline DB Press 3x10 · Lat Pulldown 3x10 · Lateral Raises 3x15 · Tricep Pushdowns 3x12",
  ],
  Lower: [
    "Squats 4x10 · Romanian Deadlifts 3x10 · Leg Extensions 3x12 · Calf Raises 3x20",
    "Deadlifts 3x8 · Leg Press 3x12 · Hamstring Curls 3x12 · Standing Calf Raises 3x20",
  ],
  "Cardio + Core": [
    "25-min steady-state cardio · Hanging Leg Raises 3x12 · Bicycle Crunches 3x20",
    "20-min HIIT intervals · Plank 3x45s · Russian Twists 3x20",
    "30-min incline walk · Cable Crunches 3x15 · Side Plank 2x30s",
  ],
  Rest: [
    "Light stretching or a 20-min walk",
    "Foam rolling + mobility work, 15-20 min",
    "Full recovery — hydrate well and sleep",
  ],
};

// Builds a 7-day week (so you can always see the full week at a glance)
// with exactly the number of training days the person actually chose —
// the rest are Rest days, placed for reasonable recovery spacing.
function buildWeekPattern(daysVal, goal) {
  const days = Math.max(1, Math.min(6, workoutDaysCount(daysVal)));
  const patterns = {
    1: ["Full Body", "Rest", "Rest", "Rest", "Rest", "Rest", "Rest"],
    2: ["Full Body", "Rest", "Rest", "Full Body", "Rest", "Rest", "Rest"],
    3: goal === "Build Muscle"
      ? ["Push", "Rest", "Pull", "Rest", "Legs", "Rest", "Rest"]
      : ["Full Body", "Rest", "Full Body", "Rest", "Full Body", "Rest", "Rest"],
    4: ["Upper", "Lower", "Rest", "Upper", "Lower", "Rest", "Rest"],
    5: ["Push", "Pull", "Legs", "Rest", "Upper", "Lower", "Rest"],
    6: ["Push", "Pull", "Legs", "Rest", "Push", "Pull", "Legs"],
  };
  const pattern = [...patterns[days]];
  if (goal === "Lose Fat" && days >= 2) {
    const trainIdxs = pattern.map((p, i) => (p !== "Rest" ? i : -1)).filter((i) => i >= 0);
    pattern[trainIdxs[trainIdxs.length - 1]] = "Cardio + Core";
  }
  return pattern;
}

function splitName(daysVal, goal) {
  const days = workoutDaysCount(daysVal);
  if (days <= 2) return "Full Body";
  if (days === 3) return goal === "Build Muscle" ? "Push / Pull / Legs" : "Full Body";
  if (days === 4) return "Upper / Lower";
  return "Push / Pull / Legs";
}

const DIET_MEAL_VARIANTS = {
  Vegetarian: [
    [["Breakfast", "Oats with milk, banana, and a handful of almonds"], ["Mid-Morning", "Greek yogurt with mixed nuts"], ["Lunch", "Brown rice, paneer curry, mixed vegetable salad"], ["Evening", "Protein shake + fruit"], ["Dinner", "Dal, roti, sabzi, and curd"]],
    [["Breakfast", "Vegetable poha with peanuts"], ["Mid-Morning", "Sprouts chaat"], ["Lunch", "Rajma, brown rice, cucumber salad"], ["Evening", "Roasted chana + fruit"], ["Dinner", "Palak paneer, roti, curd"]],
  ],
  Vegan: [
    [["Breakfast", "Overnight oats with plant milk and chia seeds"], ["Mid-Morning", "Roasted chickpeas and almonds"], ["Lunch", "Quinoa, tofu stir-fry, mixed greens"], ["Evening", "Plant-based protein shake"], ["Dinner", "Lentil curry, brown rice, sautéed vegetables"]],
    [["Breakfast", "Smoothie with banana, oats, and almond butter"], ["Mid-Morning", "Trail mix"], ["Lunch", "Chickpea salad bowl with tahini"], ["Evening", "Hummus with veggie sticks"], ["Dinner", "Tofu stir-fry with brown rice"]],
  ],
  Keto: [
    [["Breakfast", "Scrambled eggs with avocado and spinach"], ["Mid-Morning", "A handful of macadamia nuts"], ["Lunch", "Grilled chicken, olive oil salad, cheese"], ["Evening", "Boiled eggs"], ["Dinner", "Salmon with buttered greens"]],
    [["Breakfast", "Bulletproof coffee + boiled eggs"], ["Mid-Morning", "Cheese cubes"], ["Lunch", "Grilled paneer or chicken salad with olive oil"], ["Evening", "Almonds"], ["Dinner", "Butter chicken (no rice), sautéed greens"]],
  ],
  "High-Protein": [
    [["Breakfast", "4 egg whites + 2 whole eggs, oats"], ["Mid-Morning", "Protein shake"], ["Lunch", "Grilled chicken breast, brown rice, salad"], ["Evening", "Cottage cheese + fruit"], ["Dinner", "Fish or lean meat, steamed vegetables"]],
    [["Breakfast", "Greek yogurt with protein granola"], ["Mid-Morning", "Boiled eggs"], ["Lunch", "Grilled fish, quinoa, salad"], ["Evening", "Protein bar or shake"], ["Dinner", "Lean turkey or chicken, roasted vegetables"]],
  ],
  "No Restrictions": [
    [["Breakfast", "Oats with banana and 2 boiled eggs"], ["Mid-Morning", "Greek yogurt + mixed nuts"], ["Lunch", "Brown rice, grilled chicken, salad"], ["Evening", "Protein shake + fruit"], ["Dinner", "Dal, roti, sabzi and curd"]],
    [["Breakfast", "Vegetable omelette with toast"], ["Mid-Morning", "Fruit + peanut butter"], ["Lunch", "Grilled fish, rice, sautéed vegetables"], ["Evening", "Roasted makhana"], ["Dinner", "Chicken curry, roti, salad"]],
  ],
};

function generatePlan(details, answers, report) {
  const goal = answers.goal || "General Fitness";
  const diet = answers.diet || "No Restrictions";
  // Stable per-lead seed: same person always sees the same plan (no
  // flicker on re-render), different people get real variety.
  const seedBase = `${details.phone || details.email || "lead"}-${goal}-${diet}`;

  const pattern = buildWeekPattern(answers.workoutDays, goal);
  const workoutDays = pattern.map((focus, i) => {
    const pool = EXERCISE_POOL[focus] || EXERCISE_POOL["Full Body"];
    const exercises = pool[seededIndex(`${seedBase}-day${i}-${focus}`, pool.length)];
    return { day: DAY_NAMES[i], focus, exercises };
  });

  const variants = DIET_MEAL_VARIANTS[diet] || DIET_MEAL_VARIANTS["No Restrictions"];
  const chosenVariant = variants[seededIndex(`${seedBase}-diet`, variants.length)];
  const meals = chosenVariant.map(([meal, items]) => ({ meal, items }));

  const supplementTips = [
    report.protein >= 130
      ? "Your protein target is high — split it across 4-5 meals for better absorption"
      : "A whey or plant protein shake can help you consistently hit your daily protein target",
    "5g creatine monohydrate daily supports strength and recovery",
    (answers.sleep === "<5 hrs" || answers.sleep === "5-6 hrs")
      ? "Prioritize sleep — aim for 7+ hours, it affects recovery more than any supplement"
      : "Your sleep looks solid — keep that consistent, it's doing real work for recovery",
    "Magnesium before bed can support muscle recovery and sleep quality",
  ];

  const roadmap = [
    { range: "Week 1-2", milestone: "Build the habit — dial in form, consistency, and your new calorie target" },
    { range: "Week 3-6", milestone: goal === "Lose Fat" ? "Visible fat loss begins, energy levels improve" : goal === "Build Muscle" ? "Strength gains accelerate, early muscle definition appears" : "Noticeable improvement in stamina and strength" },
    { range: "Week 7-12", milestone: goal === "Lose Fat" ? "Significant visible transformation, clothes fit differently" : goal === "Build Muscle" ? "Clear muscle growth, strength PRs across major lifts" : "Major fitness milestones hit, new baseline established" },
    { range: "Week 12+", milestone: "Time to reassess goals with your trainer and set your next target" },
  ];

  return { workoutDays, meals, supplementTips, roadmap };
}

/* ============================================================
   ADMIN — metrics + mock data fallback
   ============================================================ */
function computeMetrics(leads) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const budgetValue = { "Under ₹1500": 1200, "₹1500-3000": 2200, "₹3000+": 3500 };

  let today = 0, week = 0, month = 0, booked = 0, revenue = 0;
  leads.forEach((l) => {
    const created = new Date(l.created_at);
    if (created >= startOfDay) today++;
    if (created >= weekAgo) week++;
    if (created >= monthAgo) month++;
    if (l.status === "booked" || l.status === "joined") {
      booked++;
      revenue += budgetValue[l.budget] || 1800;
    }
  });
  const conversion = leads.length ? Math.round((booked / leads.length) * 100) : 0;
  return { today, week, month, booked, conversion, revenue, total: leads.length };
}

function computeDailySeries(leads, days) {
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    buckets.push({ time: d.getTime(), label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), count: 0 });
  }
  leads.forEach((l) => {
    const created = new Date(l.created_at);
    created.setHours(0, 0, 0, 0);
    const match = buckets.find((b) => b.time === created.getTime());
    if (match) match.count++;
  });
  return buckets;
}

function computeMonthlySeries(leads, months) {
  const buckets = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({ y: d.getFullYear(), m: d.getMonth(), label: d.toLocaleDateString(undefined, { month: "short" }), count: 0 });
  }
  leads.forEach((l) => {
    const created = new Date(l.created_at);
    const match = buckets.find((b) => b.y === created.getFullYear() && b.m === created.getMonth());
    if (match) match.count++;
  });
  return buckets;
}

function computeFunnel(leads) {
  const total = leads.length;
  const contactedPlus = leads.filter((l) => ["contacted", "booked", "joined"].includes(l.status)).length;
  const bookedPlus = leads.filter((l) => ["booked", "joined"].includes(l.status)).length;
  const joined = leads.filter((l) => l.status === "joined").length;
  return [
    { label: "Total Leads", count: total },
    { label: "Contacted", count: contactedPlus },
    { label: "Booked", count: bookedPlus },
    { label: "Joined", count: joined },
  ];
}

function computeDistribution(leads, key, order) {
  const counts = {};
  order.forEach((o) => { counts[o] = 0; });
  leads.forEach((l) => { if (l[key] && counts[l[key]] !== undefined) counts[l[key]]++; });
  return order.map((label) => ({ label, count: counts[label] || 0 }));
}

function computeBmiDistribution(leads) {
  const buckets = { Underweight: 0, Normal: 0, Overweight: 0, Obese: 0 };
  leads.forEach((l) => {
    const cat = l.bmi_category || (l.bmi ? (l.bmi < 18.5 ? "Underweight" : l.bmi < 25 ? "Normal" : l.bmi < 30 ? "Overweight" : "Obese") : null);
    if (cat && buckets[cat] !== undefined) buckets[cat]++;
  });
  return Object.entries(buckets).map(([label, count]) => ({ label, count }));
}

function computeAgeDistribution(leads) {
  const buckets = { "18-24": 0, "25-34": 0, "35-44": 0, "45-54": 0, "55+": 0 };
  leads.forEach((l) => {
    const age = l.age;
    if (!age) return;
    if (age <= 24) buckets["18-24"]++;
    else if (age <= 34) buckets["25-34"]++;
    else if (age <= 44) buckets["35-44"]++;
    else if (age <= 54) buckets["45-54"]++;
    else buckets["55+"]++;
  });
  return Object.entries(buckets).map(([label, count]) => ({ label, count }));
}

// Realistic fallback data so the dashboard never looks broken/empty
// before any real leads exist. Clearly labeled as sample data in the UI.
function generateMockLeads() {
  const firstNames = ["Rahul", "Priya", "Aman", "Sneha", "Vikram", "Anjali", "Karan", "Neha", "Rohit", "Divya", "Arjun", "Pooja", "Siddharth", "Kavya", "Manish", "Riya"];
  const lastNames = ["Sharma", "Verma", "Iyer", "Kapoor", "Nair", "Gupta", "Reddy", "Singh", "Mehta", "Joshi"];
  const goals = ["Lose Fat", "Build Muscle", "Weight Gain", "Strength", "General Fitness"];
  const statuses = ["new", "new", "new", "contacted", "contacted", "booked", "booked", "joined", "lost"];
  const budgets = ["Under ₹1500", "₹1500-3000", "₹3000+"];
  const cities = ["Mumbai", "Pune", "Bengaluru", "Delhi", "Hyderabad"];
  const experience = ["Beginner", "Intermediate", "Advanced"];
  const lifestyles = ["Mostly Sedentary", "Lightly Active", "Very Active"];
  const joinTimes = ["Today", "This Week", "This Month"];
  const reasonBank = [
    "Ready to join immediately", "Planning to join this week", "Budget available for premium plan",
    "Clear transformation need", "Beginner — high guidance need", "High weekly commitment",
  ];

  const leads = [];
  for (let i = 0; i < 28; i++) {
    const fn = firstNames[i % firstNames.length];
    const ln = lastNames[(i * 3) % lastNames.length];
    const daysAgo = Math.floor(Math.random() * 30);
    const created = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000 - Math.floor(Math.random() * 24 * 60 * 60 * 1000));
    const bmi = +(18 + Math.random() * 14).toFixed(1);
    const bmiCategory = bmi < 18.5 ? "Underweight" : bmi < 25 ? "Normal" : bmi < 30 ? "Overweight" : "Obese";
    const workoutDays = 2 + (i % 5);
    const bodyScore = 45 + Math.floor(Math.random() * 48);

    leads.push({
      id: `mock-${i}`,
      created_at: created.toISOString(),
      first_name: fn,
      last_name: ln,
      phone: `+91 9${String(100000000 + ((i * 7919) % 899999999)).slice(0, 8)}`,
      email: `${fn.toLowerCase()}.${ln.toLowerCase()}@email.com`,
      city: cities[i % cities.length],
      age: 18 + ((i * 5) % 42),
      goal: goals[i % goals.length],
      experience_level: experience[i % experience.length],
      lifestyle: lifestyles[i % lifestyles.length],
      workout_days: workoutDays,
      budget: budgets[i % budgets.length],
      joining_time: joinTimes[i % joinTimes.length],
      bmi,
      bmi_category: bmiCategory,
      body_score: bodyScore,
      daily_calories: 1800 + (i % 6) * 120,
      protein_g: 110 + (i % 5) * 15,
      status: statuses[i % statuses.length],
      lead_score: 40 + Math.floor(Math.random() * 59),
      lead_score_reasons: [reasonBank[i % reasonBank.length], reasonBank[(i + 2) % reasonBank.length]],
      notes: "",
    });
  }
  return leads.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

/* ============================================================
   AI INTERVIEW — question config
   ============================================================ */
const QUESTIONS = [
  { key: "goal", ai: "What's your primary fitness goal?", type: "choice", options: ["Lose Fat", "Build Muscle", "Weight Gain", "Strength", "General Fitness"] },
  { key: "experience", ai: "Nice. How would you describe your training experience?", type: "choice", options: ["Beginner", "Intermediate", "Advanced"] },
  { key: "workoutDays", ai: "How many days a week can you realistically train?", type: "choice", options: ["1-2", "3", "4", "5", "6"] },
  { key: "occupation", ai: "What do you do for work? This helps me factor in your daily activity.", type: "text", placeholder: "e.g. Software Engineer" },
  { key: "lifestyle", ai: "How would you describe your day-to-day lifestyle?", type: "choice", options: ["Mostly Sedentary", "Lightly Active", "Very Active"] },
  { key: "diet", ai: "Any dietary preference I should plan around?", type: "choice", options: ["No Restrictions", "Vegetarian", "Vegan", "Keto", "High-Protein"] },
  { key: "medical", ai: "Any medical conditions I should be aware of?", type: "text", placeholder: "e.g. None, or Diabetes / Thyroid..." },
  { key: "injuries", ai: "Any current injuries or physical limitations?", type: "text", placeholder: "e.g. None, or knee pain..." },
  { key: "water", ai: "Roughly how much water do you drink daily?", type: "choice", options: ["<1L", "1-2L", "2-3L", "3L+"] },
  { key: "sleep", ai: "How many hours do you usually sleep?", type: "choice", options: ["<5 hrs", "5-6 hrs", "7-8 hrs", "8+ hrs"] },
  { key: "stress", ai: "How would you rate your everyday stress level?", type: "choice", options: ["Low", "Moderate", "High"] },
  { key: "targetWeight", ai: "What's your target weight, in kg?", type: "number", placeholder: "e.g. 68" },
  { key: "budget", ai: "What's your monthly budget for a fitness program?", type: "choice", options: ["Under ₹1500", "₹1500-3000", "₹3000+"] },
  { key: "joiningTime", ai: "Last one — when would you like to begin?", type: "choice", options: ["Today", "This Week", "This Month"] },
];

/* ============================================================
   APP
   ============================================================ */
export default function GymLeadTool() {
  const [area, setArea] = useState("visitor"); // visitor | admin
  const [screen, setScreen] = useState("landing"); // landing | details | interview | analysis | report
  const [details, setDetails] = useState({ firstName: "", lastName: "", phone: "", email: "", age: "", gender: "Male", height: "", weight: "", city: "" });
  const [errors, setErrors] = useState({});
  const [answers, setAnswers] = useState({});
  const [report, setReport] = useState(null);
  const [leadScore, setLeadScore] = useState(null);
  const [leadId, setLeadId] = useState(null);
  const [saveStatus, setSaveStatus] = useState("idle"); // idle | saving | saved | failed

  const goDetails = () => setScreen("details");

  const validateDetails = () => {
    const e = {};
    if (!details.firstName.trim()) e.firstName = "Required";
    if (!details.lastName.trim()) e.lastName = "Required";
    if (!/^[\d+\s-]{7,}$/.test(details.phone)) e.phone = "Enter a valid phone number";
    if (!/^\S+@\S+\.\S+$/.test(details.email)) e.email = "Enter a valid email";
    if (!details.age || details.age < 12 || details.age > 90) e.age = "Enter a valid age";
    if (!details.height || details.height < 100 || details.height > 250) e.height = "Enter height in cm";
    if (!details.weight || details.weight < 30 || details.weight > 250) e.weight = "Enter weight in kg";
    if (!details.city.trim()) e.city = "Required";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const onContinueDetails = () => {
    if (validateDetails()) setScreen("interview");
  };

  const onInterviewDone = (finalAnswers) => {
    setAnswers(finalAnswers);
    setScreen("analysis");
  };

  const onAnalysisDone = async () => {
    const rep = computeReport({ ...details, ...answers });
    const scoring = computeLeadScore(answers, rep);
    const newLeadId = genId();
    setReport(rep);
    setLeadScore(scoring);
    setLeadId(newLeadId);
    setScreen("report");
    setSaveStatus("saving");

    const payload = {
      id: newLeadId,
      first_name: details.firstName,
      last_name: details.lastName,
      phone: details.phone,
      email: details.email,
      age: parseInt(details.age),
      gender: details.gender,
      height_cm: parseFloat(details.height),
      weight_kg: parseFloat(details.weight),
      city: details.city,
      goal: answers.goal,
      experience_level: answers.experience,
      workout_days: parseInt(answers.workoutDays) || null,
      occupation: answers.occupation,
      lifestyle: answers.lifestyle,
      diet_preference: answers.diet,
      medical_conditions: answers.medical,
      injuries: answers.injuries,
      water_intake: answers.water,
      sleep_hours: answers.sleep,
      stress_level: answers.stress,
      target_weight_kg: parseFloat(answers.targetWeight) || null,
      budget: answers.budget,
      joining_time: answers.joiningTime,
      bmi: rep.bmi,
      bmi_category: rep.bmiCategory,
      body_score: rep.bodyScore,
      daily_calories: rep.calories,
      protein_g: rep.protein,
      lead_score: scoring.score,
      lead_score_reasons: scoring.reasons,
    };

    const res = await insertLead(payload);
    setSaveStatus(res.ok ? "saved" : res.skipped ? "idle" : "failed");
    pushToSheet(payload); // fire-and-forget, doesn't affect saveStatus
  };

  if (area === "admin") {
    return <AdminApp onExit={() => setArea("visitor")} />;
  }

  return (
    <div style={S.app}>
      <GlobalStyle />
      <Background />

      <div style={S.header}>
        <div style={S.logo}><span style={{ color: PRIMARY }}>⚡ </span>{gymName}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={S.badge}>AI Fitness Consultant</div>
          <button
            onClick={() => setArea("admin")}
            style={{ background: "none", border: "none", color: SUBTEXT, fontSize: 11, fontWeight: 600, cursor: "pointer", textDecoration: "underline", padding: 0 }}
          >
            Gym Owner? Admin Login
          </button>
        </div>
      </div>

      <div style={S.page}>
        {screen === "landing" && <Landing onStart={goDetails} />}
        {screen === "details" && (
          <DetailsForm
            details={details} setDetails={setDetails} errors={errors}
            onBack={() => setScreen("landing")} onContinue={onContinueDetails}
          />
        )}
        {screen === "interview" && (
          <Interview onDone={onInterviewDone} onBack={() => setScreen("details")} />
        )}
        {screen === "analysis" && <Analysis onDone={onAnalysisDone} />}
        {screen === "report" && report && (
          <Report details={details} answers={answers} report={report} saveStatus={saveStatus} leadId={leadId} />
        )}
      </div>
    </div>
  );
}

/* ============================================================
   GLOBAL STYLE / KEYFRAMES
   ============================================================ */
function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700;800&display=swap');
      * { box-sizing:border-box; }
      body { margin:0; }
      ::-webkit-scrollbar { height:4px; width:4px; }
      ::-webkit-scrollbar-track { background:#111; }
      ::-webkit-scrollbar-thumb { background:#333; border-radius:2px; }
      @keyframes floaty { 0%,100%{ transform:translateY(0);} 50%{ transform:translateY(-14px);} }
      @keyframes fadeUp { from{opacity:0; transform:translateY(10px);} to{opacity:1; transform:translateY(0);} }
      @keyframes pulse { 0%,100%{ transform:scale(1); opacity:1;} 50%{ transform:scale(1.06); opacity:.85;} }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes dotBounce { 0%,80%,100%{ transform:translateY(0);} 40%{ transform:translateY(-5px);} }
      @keyframes shimmer { 0%{ background-position:100% 50%; } 100%{ background-position:0 50%; } }
      .fadeUp { animation: fadeUp .45s ease both; }
      button:active { transform: scale(0.98); }
      input:focus { border-color: ${PRIMARY} !important; }
      textarea:focus { border-color: ${PRIMARY} !important; }
      .lead-row:hover { background: rgba(255,255,255,0.03); }
      .skel { background: linear-gradient(90deg,#1a1a1a 25%,#242424 37%,#1a1a1a 63%); background-size:400% 100%; animation: shimmer 1.4s ease infinite; }
      .stat-grid { display:grid; grid-template-columns: repeat(2,1fr); gap:12px; margin-bottom:20px; }
      .admin-shell { display:flex; flex-direction:column; max-width:1100px; margin:0 auto; position:relative; z-index:2; }
      .admin-nav { display:flex; flex-direction:row; gap:6px; overflow-x:auto; padding:14px 20px; border-bottom:1px solid ${BORDER}; }
      .admin-content { padding:24px 20px 60px; flex:1; min-width:0; }
      @media (min-width:640px) { .stat-grid { grid-template-columns: repeat(3,1fr); } }
      @media (min-width:860px) {
        .admin-shell { flex-direction:row; }
        .admin-nav { flex-direction:column; width:220px; flex-shrink:0; border-right:1px solid ${BORDER}; border-bottom:none; padding:24px 14px; overflow-x:visible; }
        .admin-content { padding:32px 40px; }
      }
    `}</style>
  );
}

/* ============================================================
   LANDING
   ============================================================ */
function Landing({ onStart }) {
  const [counts, setCounts] = useState({ members: 0, assessments: 0, plans: 0 });
  useEffect(() => {
    const targets = { members: 2840, assessments: 5120, plans: 1960 };
    const start = performance.now();
    const dur = 1400;
    let raf;
    const tick = (t) => {
      const p = Math.min(1, (t - start) / dur);
      setCounts({
        members: Math.round(targets.members * p),
        assessments: Math.round(targets.assessments * p),
        plans: Math.round(targets.plans * p),
      });
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="fadeUp">
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14 }}>
        {Array.from({ length: 5 }).map((_, i) => <Star key={i} size={14} fill={PRIMARY} color={PRIMARY} />)}
        <span style={{ fontSize: 12, color: SUBTEXT, marginLeft: 4 }}>Trusted by fitness enthusiasts</span>
      </div>
      <h1 style={S.h1}>Get Your Personalized <span style={{ color: PRIMARY }}>AI Fitness Report</span> in 60 Seconds</h1>
      <p style={S.sub}>Receive your BMI, calorie target, workout recommendation, nutrition analysis, and body transformation roadmap instantly.</p>

      <div style={S.card}>
        {[
          { icon: Activity, t: "Full BMI & body composition analysis" },
          { icon: Dumbbell, t: "Custom workout split for your goal" },
          { icon: Flame, t: "Calorie & macro targets, calculated for you" },
          { icon: Target, t: "A real transformation timeline" },
        ].map((f, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: i < 3 ? 12 : 0 }}>
            <f.icon size={16} color={PRIMARY} />
            <span style={{ fontSize: 13, color: "#ccc" }}>{f.t}</span>
          </div>
        ))}
      </div>

      <button style={S.btnP} onClick={onStart}>
        <Sparkles size={16} /> Start Free Assessment
      </button>

      <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
        <StatCard icon={Users} value={counts.members.toLocaleString()} label="Members Helped" />
        <StatCard icon={FileText} value={counts.assessments.toLocaleString()} label="Assessments Generated" />
        <StatCard icon={TrendingUp} value={counts.plans.toLocaleString()} label="Transformation Plans" />
      </div>
    </div>
  );
}

/* ============================================================
   STEP 1 — DETAILS FORM
   ============================================================ */
function Field({ label, error, children }) {
  return (
    <div>
      <label style={S.label}>{label}</label>
      {children}
      {error && <div style={S.errorText}>{error}</div>}
    </div>
  );
}

function DetailsForm({ details, setDetails, errors, onBack, onContinue }) {
  const set = (k) => (e) => setDetails((d) => ({ ...d, [k]: e.target.value }));
  return (
    <div className="fadeUp">
      <div style={S.stepLabel}>Step 1 of 3</div>
      <ProgressBar step={1} />
      <h1 style={S.h1}>Let's get to<br />know you</h1>
      <p style={S.sub}>We'll use this to personalize every part of your report.</p>

      <div style={S.card}>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Field label="First Name" error={errors.firstName}>
              <input style={S.input} value={details.firstName} onChange={set("firstName")} placeholder="Rahul" />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Last Name" error={errors.lastName}>
              <input style={S.input} value={details.lastName} onChange={set("lastName")} placeholder="Sharma" />
            </Field>
          </div>
        </div>
        <Field label="Phone Number" error={errors.phone}>
          <input style={S.input} value={details.phone} onChange={set("phone")} placeholder="+91 98765 43210" />
        </Field>
        <Field label="Email Address" error={errors.email}>
          <input style={S.input} value={details.email} onChange={set("email")} placeholder="rahul@email.com" />
        </Field>

        <label style={S.label}>Gender</label>
        <div style={S.pillRow}>
          {["Male", "Female", "Other"].map((g) => (
            <div key={g} style={S.pill(details.gender === g)} onClick={() => setDetails((d) => ({ ...d, gender: g }))}>{g}</div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Field label="Age" error={errors.age}>
              <input style={S.input} type="number" value={details.age} onChange={set("age")} placeholder="25" />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Height (cm)" error={errors.height}>
              <input style={S.input} type="number" value={details.height} onChange={set("height")} placeholder="175" />
            </Field>
          </div>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Field label="Weight (kg)" error={errors.weight}>
              <input style={S.input} type="number" value={details.weight} onChange={set("weight")} placeholder="78" />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="City" error={errors.city}>
              <input style={S.input} value={details.city} onChange={set("city")} placeholder="Mumbai" />
            </Field>
          </div>
        </div>
        <p style={{ fontSize: 11, color: "#555", margin: "4px 0 0" }}>🔒 We never spam or share your data.</p>
      </div>

      <button style={S.btnP} onClick={onContinue}>Continue <ArrowRight size={16} /></button>
      <button style={S.btnS} onClick={onBack}><ArrowLeft size={14} /> Back</button>
    </div>
  );
}

/* ============================================================
   STEP 2 — AI CHAT INTERVIEW
   ============================================================ */
function TypingDots() {
  return (
    <div style={{ display: "flex", gap: 4, padding: "10px 14px" }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: SUBTEXT, animation: `dotBounce 1.1s ${i * 0.15}s infinite` }} />
      ))}
    </div>
  );
}

function Interview({ onDone, onBack }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [thinking, setThinking] = useState(true);
  const [visible, setVisible] = useState(false);
  const [textVal, setTextVal] = useState("");
  const endRef = useRef(null);

  const q = QUESTIONS[step];

  useEffect(() => {
    setThinking(true);
    setVisible(false);
    setTextVal("");
    const t1 = setTimeout(() => { setThinking(false); setVisible(true); }, 550);
    return () => clearTimeout(t1);
  }, [step]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [step, thinking]);

  const answer = (val) => {
    const next = { ...answers, [q.key]: val };
    setAnswers(next);
    if (step + 1 < QUESTIONS.length) {
      setStep(step + 1);
    } else {
      onDone(next);
    }
  };

  const answeredList = QUESTIONS.slice(0, step);

  return (
    <div className="fadeUp">
      <div style={S.stepLabel}>Step 2 of 3 · AI Interview</div>
      <ProgressBar step={2} />
      <h1 style={{ ...S.h1, fontSize: 26 }}>Talking with your<br /><span style={{ color: PRIMARY }}>AI consultant</span></h1>

      <div style={{ ...S.card, maxHeight: 420, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
        {answeredList.map((aq, i) => (
          <div key={aq.key}>
            <ChatBubble from="ai">{aq.ai}</ChatBubble>
            <ChatBubble from="user">{String(answers[aq.key])}</ChatBubble>
          </div>
        ))}

        {thinking ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AiAvatar />
            <div style={{ background: MUTED, borderRadius: "14px 14px 14px 4px" }}><TypingDots /></div>
          </div>
        ) : (
          visible && <ChatBubble from="ai">{q.ai}</ChatBubble>
        )}
        <div ref={endRef} />
      </div>

      {!thinking && visible && (
        <div className="fadeUp">
          {q.type === "choice" && (
            <div style={S.pillRow}>
              {q.options.map((opt) => (
                <div key={opt} style={S.pill(false)} onClick={() => answer(opt)}>{opt}</div>
              ))}
            </div>
          )}
          {(q.type === "text" || q.type === "number") && (
            <div style={{ display: "flex", gap: 8 }}>
              <input
                style={{ ...S.input, marginBottom: 0 }}
                type={q.type === "number" ? "number" : "text"}
                placeholder={q.placeholder}
                value={textVal}
                onChange={(e) => setTextVal(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && textVal.trim()) answer(textVal.trim()); }}
              />
              <button
                style={{ ...S.btnP, width: "auto", padding: "0 18px", marginTop: 0 }}
                disabled={!textVal.trim()}
                onClick={() => textVal.trim() && answer(textVal.trim())}
              >
                <ArrowRight size={16} />
              </button>
            </div>
          )}
        </div>
      )}

      {step === 0 && <button style={S.btnS} onClick={onBack}><ArrowLeft size={14} /> Back</button>}
    </div>
  );
}

function AiAvatar() {
  return (
    <div style={{ width: 24, height: 24, borderRadius: "50%", background: `linear-gradient(135deg,${PRIMARY},${AI_GLOW})`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <Sparkles size={12} color={DARK} />
    </div>
  );
}

function ChatBubble({ from, children }) {
  const isAi = from === "ai";
  return (
    <div style={{ display: "flex", justifyContent: isAi ? "flex-start" : "flex-end", gap: 8, marginBottom: 4 }}>
      {isAi && <AiAvatar />}
      <div style={{
        maxWidth: "78%", padding: "10px 14px", fontSize: 13, lineHeight: 1.5,
        background: isAi ? MUTED : `${PRIMARY}20`,
        color: isAi ? "#ddd" : PRIMARY,
        borderRadius: isAi ? "14px 14px 14px 4px" : "14px 14px 4px 14px",
        border: isAi ? "none" : `1px solid ${PRIMARY}40`,
      }}>{children}</div>
    </div>
  );
}

/* ============================================================
   STEP 3 — AI ANALYSIS
   ============================================================ */
const ANALYSIS_MESSAGES = [
  "Analyzing BMI...", "Analyzing lifestyle...", "Calculating calories...",
  "Calculating protein needs...", "Preparing workout plan...",
  "Preparing nutrition strategy...", "Estimating timeline...",
  "Generating personalized report...",
];

function Analysis({ onDone }) {
  const [progress, setProgress] = useState(0);
  const [msgIdx, setMsgIdx] = useState(0);

  useEffect(() => {
    const total = 4200;
    const start = performance.now();
    let raf;
    const tick = (t) => {
      const p = Math.min(1, (t - start) / total);
      setProgress(p * 100);
      setMsgIdx(Math.min(ANALYSIS_MESSAGES.length - 1, Math.floor(p * ANALYSIS_MESSAGES.length)));
      if (p < 1) raf = requestAnimationFrame(tick);
      else setTimeout(onDone, 350);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [onDone]);

  return (
    <div className="fadeUp" style={{ textAlign: "center", paddingTop: 40 }}>
      <div style={{
        width: 96, height: 96, margin: "0 auto 28px", borderRadius: "50%",
        background: `radial-gradient(circle,${PRIMARY}25,transparent 70%)`,
        display: "flex", alignItems: "center", justifyContent: "center",
        animation: "pulse 1.8s ease-in-out infinite",
      }}>
        <Brain size={40} color={PRIMARY} />
      </div>
      <h1 style={{ ...S.h1, fontSize: 24 }}>Building your report</h1>
      <p style={{ fontSize: 13, color: PRIMARY, fontWeight: 600, minHeight: 18, marginBottom: 24 }}>{ANALYSIS_MESSAGES[msgIdx]}</p>

      <div style={{ height: 6, background: MUTED, borderRadius: 6, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${progress}%`, background: `linear-gradient(90deg,${PRIMARY},${AI_GLOW})`, borderRadius: 6, transition: "width .1s linear" }} />
      </div>
      <div style={{ fontSize: 11, color: SUBTEXT, marginTop: 8 }}>{Math.round(progress)}%</div>
    </div>
  );
}

/* ============================================================
   STEP 4 — REPORT
   ============================================================ */
function Report({ details, answers, report, saveStatus, leadId }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [slotDate, setSlotDate] = useState("Today");
  const [slotTime, setSlotTime] = useState("Morning");
  const [booking, setBooking] = useState("idle"); // idle | saving | done
  const [dismissed, setDismissed] = useState(false);

  const plan = generatePlan(details, answers, report);
  const unlocked = booking === "done";

  const confirmBooking = async () => {
    setBooking("saving");
    await bookConsultation(leadId, `${slotDate} · ${slotTime}`);
    setBooking("done");
  };

  const waMessage = `Hi! I just completed my AI fitness assessment at ${gymName}. My goal is ${answers.goal || "getting fit"} and I'd like to book a free consultation. My name is ${details.firstName}.`;
  const waLink = `https://wa.me/${GYM_WHATSAPP_NUMBER}?text=${encodeURIComponent(waMessage)}`;

  return (
    <div className="fadeUp">
      <div style={S.stepLabel}>Your Report Is Ready</div>
      <ProgressBar step={4} />
      <h1 style={{ ...S.h1, fontSize: 28 }}>Hey {details.firstName || "there"},<br />here's your <span style={{ color: PRIMARY }}>AI report</span></h1>

      <div style={{ ...S.card, display: "flex", alignItems: "center", gap: 20 }}>
        <CircularStat value={report.bodyScore} label="BODY SCORE" />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: SUBTEXT, marginBottom: 4 }}>Overall assessment</div>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 2 }}>
            BMI {report.bmi} · <span style={{ color: PRIMARY }}>{report.bmiCategory}</span>
          </div>
          <div style={{ fontSize: 12, color: "#999", lineHeight: 1.5 }}>
            A solid starting point. With consistent training, you can see visible change in 4-6 weeks.
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <StatCard icon={Flame} value={report.calories} label="Daily Calories" />
        <StatCard icon={Dumbbell} value={`${report.protein}g`} label="Protein / day" />
        <StatCard icon={Droplet} value={`${report.water}L`} label="Water / day" />
      </div>

      <div style={S.card}>
        <div style={S.stepLabel}>Recommended Program</div>
        <div style={{ fontSize: 13, color: "#ccc", lineHeight: 1.8 }}>
          <div><strong style={{ color: TEXT }}>Split:</strong> {splitName(answers.workoutDays, answers.goal)}, {workoutDaysCount(answers.workoutDays)}x weekly</div>
          <div><strong style={{ color: TEXT }}>Cardio:</strong> {answers.goal === "Lose Fat" ? "4x weekly, 25-30 min moderate cardio" : "2-3x weekly, light-to-moderate cardio"}</div>
          <div><strong style={{ color: TEXT }}>Estimated timeline:</strong> visible change in 4-6 weeks, major transformation in 12-16 weeks</div>
        </div>
      </div>

      <div style={{ margin: "22px 0 10px", fontSize: 13, fontWeight: 700, color: TEXT, display: "flex", alignItems: "center", gap: 6 }}>
        {unlocked ? <CheckCircle2 size={14} color={PRIMARY} /> : <Lock size={14} color={PRIMARY} />}
        {unlocked ? "Your complete personalized plan" : "Your complete personalized plan (locked)"}
      </div>

      {!unlocked ? (
        <>
          <LockedCard icon={Dumbbell} title="Complete Workout Schedule" blurb="Full 7-day exercise breakdown with sets, reps and progressive overload tracking tailored to your split." />
          <LockedCard icon={Flame} title="Complete Meal Plan" blurb="Every meal, portion size, and macro breakdown mapped to your calorie and protein targets." />
          <LockedCard icon={Sparkles} title="Supplement & Recovery Plan" blurb="What actually helps at your level, mobility work, and a recovery protocol matched to your sleep and stress." />
          <LockedCard icon={TrendingUp} title="12-Week Transformation Roadmap" blurb="Week-by-week milestones so you always know if you're on track." />
        </>
      ) : (
        <div className="fadeUp">
          <div style={S.card}>
            <div style={S.stepLabel}>🏋️ 7-Day Workout Schedule</div>
            {plan.workoutDays.map((d, i) => (
              <div key={i} style={{ padding: "9px 0", borderBottom: i < plan.workoutDays.length - 1 ? `1px solid ${BORDER}` : "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                  <strong style={{ fontSize: 12.5 }}>{d.day}</strong>
                  <span style={{ fontSize: 11, fontWeight: 700, color: PRIMARY, background: `${PRIMARY}18`, borderRadius: 6, padding: "2px 8px" }}>{d.focus}</span>
                </div>
                <div style={{ fontSize: 12, color: SUBTEXT }}>{d.exercises}</div>
              </div>
            ))}
          </div>

          <div style={S.card}>
            <div style={S.stepLabel}>🥗 Daily Meal Plan</div>
            {plan.meals.map((m, i) => (
              <div key={i} style={{ padding: "8px 0", borderBottom: i < plan.meals.length - 1 ? `1px solid ${BORDER}` : "none" }}>
                <strong style={{ fontSize: 12.5 }}>{m.meal}: </strong>
                <span style={{ fontSize: 12, color: SUBTEXT }}>{m.items}</span>
              </div>
            ))}
          </div>

          <div style={S.card}>
            <div style={S.stepLabel}>💊 Supplement & Recovery</div>
            {plan.supplementTips.map((tip, i) => (
              <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, fontSize: 12.5, color: "#ccc" }}>
                <CheckCircle2 size={14} color={PRIMARY} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{tip}</span>
              </div>
            ))}
          </div>

          <div style={S.card}>
            <div style={S.stepLabel}>📈 Transformation Roadmap</div>
            {plan.roadmap.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: PRIMARY, minWidth: 70 }}>{r.range}</div>
                <div style={{ fontSize: 12, color: "#ccc", lineHeight: 1.5 }}>{r.milestone}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{
        ...S.card, textAlign: "center", marginTop: 20,
        background: `linear-gradient(135deg,#101a02,#151f00)`, border: `1px solid ${PRIMARY}30`,
      }}>
        {unlocked ? (
          <>
            <CheckCircle2 size={24} color={PRIMARY} style={{ marginBottom: 8 }} />
            <h2 style={{ ...S.display, fontSize: 18, margin: "0 0 6px" }}>You're booked, {details.firstName}!</h2>
            <p style={{ fontSize: 12.5, color: SUBTEXT, margin: 0 }}>{gymName} will call {details.phone} to confirm your {slotDate.toLowerCase()} · {slotTime.toLowerCase()} slot.</p>
          </>
        ) : dismissed ? (
          <p style={{ fontSize: 12.5, color: SUBTEXT, margin: 0 }}>
            No worries — your report is saved.{" "}
            <span style={{ color: PRIMARY, fontWeight: 700, cursor: "pointer" }} onClick={() => setDismissed(false)}>Changed your mind?</span>
          </p>
        ) : (
          <>
            <h2 style={{ ...S.display, fontSize: 20, margin: "0 0 6px" }}>Ready to Transform Your Body?</h2>
            <p style={{ fontSize: 12.5, color: SUBTEXT, marginBottom: 18 }}>Book a free consultation to unlock your complete plan.</p>
            <button style={S.btnP} onClick={() => setModalOpen(true)}><Phone size={15} /> Book Free Consultation</button>
            <a href={waLink} target="_blank" rel="noopener noreferrer" style={{ ...S.btnS, color: PRIMARY, borderColor: `${PRIMARY}40`, textDecoration: "none" }}>
              <MessageCircle size={15} /> WhatsApp Trainer
            </a>
            <button style={{ ...S.btnS, border: "none" }} onClick={() => setDismissed(true)}>Maybe Later</button>
          </>
        )}
      </div>

      <div style={{ textAlign: "center", fontSize: 11, color: "#444", marginTop: 18 }}>
        {saveStatus === "saving" && <span><Loader2 size={11} style={{ animation: "spin 1s linear infinite", display: "inline-block", verticalAlign: -1 }} /> Saving your report...</span>}
        {saveStatus === "saved" && <span><CheckCircle2 size={11} style={{ display: "inline-block", verticalAlign: -1 }} color={PRIMARY} /> Report saved</span>}
        {saveStatus === "failed" && <span>Couldn't reach the server — your report is still shown above.</span>}
        {saveStatus === "idle" && <span>Demo mode — set your Supabase URL to save real leads.</span>}
      </div>

      {modalOpen && (
        <div style={S.modalOverlay} onClick={() => setModalOpen(false)}>
          <div style={S.modalCard} onClick={(e) => e.stopPropagation()} className="fadeUp">
            {booking !== "done" ? (
              <>
                <h3 style={{ ...S.display, fontSize: 18, margin: "0 0 4px" }}>Confirm your free consultation</h3>
                <p style={{ fontSize: 12, color: SUBTEXT, marginBottom: 18 }}>{details.firstName} {details.lastName} · {details.phone}</p>

                <label style={S.label}>Preferred day</label>
                <div style={S.pillRow}>
                  {["Today", "Tomorrow", "This Week"].map((d) => (
                    <div key={d} style={S.pill(slotDate === d)} onClick={() => setSlotDate(d)}>{d}</div>
                  ))}
                </div>
                <label style={S.label}>Preferred time</label>
                <div style={S.pillRow}>
                  {["Morning", "Afternoon", "Evening"].map((t) => (
                    <div key={t} style={S.pill(slotTime === t)} onClick={() => setSlotTime(t)}>{t}</div>
                  ))}
                </div>

                <button style={S.btnP} onClick={confirmBooking} disabled={booking === "saving"}>
                  {booking === "saving"
                    ? <><Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> Confirming...</>
                    : <><CheckCircle2 size={15} /> Confirm Booking</>}
                </button>
                <button style={S.btnS} onClick={() => setModalOpen(false)}>Cancel</button>
              </>
            ) : (
              <>
                <div style={{ width: 48, height: 48, borderRadius: "50%", background: `${PRIMARY}20`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
                  <CheckCircle2 size={26} color={PRIMARY} />
                </div>
                <h3 style={{ ...S.display, fontSize: 18, textAlign: "center", margin: "0 0 6px" }}>You're booked!</h3>
                <p style={{ fontSize: 12.5, color: SUBTEXT, textAlign: "center", marginBottom: 18 }}>
                  {gymName} will reach out on {details.phone} to confirm your {slotDate.toLowerCase()} · {slotTime.toLowerCase()} slot. Your complete plan is unlocked below.
                </p>
                <button style={S.btnP} onClick={() => setModalOpen(false)}>View My Full Plan</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   ADMIN AREA
   ============================================================ */
function AdminApp({ onExit }) {
  const [session, setSession] = useState(null); // { accessToken, email }

  if (!session) return <AdminLogin onLogin={setSession} onExit={onExit} />;
  return <AdminDashboard session={session} onSignOut={() => setSession(null)} onExit={onExit} />;
}

function AdminLogin({ onLogin, onExit }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setError("");
    if (!supabaseReady()) {
      setError("Supabase URL isn't set yet — can't authenticate.");
      return;
    }
    if (!email.trim() || !password) {
      setError("Enter both email and password.");
      return;
    }
    setLoading(true);
    const res = await adminSignIn(email.trim(), password);
    setLoading(false);
    if (res.ok) onLogin({ accessToken: res.accessToken, email: email.trim() });
    else setError(res.error || "Invalid email or password.");
  };

  const onEnter = (e) => {
    if (e.key === "Enter") handleLogin();
  };

  return (
    <div style={{ ...S.app, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <GlobalStyle />
      <Background />
      <div style={{ ...S.card, width: "100%", maxWidth: 380, position: "relative", zIndex: 2 }} className="fadeUp">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: `linear-gradient(135deg,${PRIMARY},${AI_GLOW})`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <LayoutDashboard size={18} color={DARK} />
          </div>
          <div style={{ fontWeight: 800, fontFamily: "'Space Grotesk',sans-serif" }}>{gymName} <span style={{ color: SUBTEXT, fontWeight: 500 }}>Admin</span></div>
        </div>
        <p style={{ fontSize: 12.5, color: SUBTEXT, marginBottom: 22 }}>Sign in to view your leads and analytics.</p>

        <div>
          <label style={S.label}>Email</label>
          <input style={S.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={onEnter} placeholder="owner@powerfitgym.com" />

          <label style={S.label}>Password</label>
          <div style={{ position: "relative" }}>
            <input
              style={{ ...S.input, paddingRight: 42 }}
              type={showPw ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={onEnter}
              placeholder="••••••••"
            />
            <span onClick={() => setShowPw((s) => !s)} style={{ position: "absolute", right: 12, top: 11, cursor: "pointer", color: SUBTEXT }}>
              {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
            </span>
          </div>

          {error && (
            <div style={{ display: "flex", gap: 6, alignItems: "flex-start", background: "#2a1010", border: "1px solid #4a1a1a", borderRadius: 8, padding: "8px 10px", marginTop: 2, marginBottom: 10 }}>
              <AlertCircle size={13} color="#FF6B6B" style={{ flexShrink: 0, marginTop: 1 }} />
              <span style={{ fontSize: 11.5, color: "#FF9B9B" }}>{error}</span>
            </div>
          )}

          <button style={S.btnP} onClick={handleLogin} disabled={loading}>
            {loading ? <><Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> Signing in...</> : "Sign In"}
          </button>
        </div>
        <button style={S.btnS} onClick={onExit}><ArrowLeft size={14} /> Back to site</button>

        {!supabaseReady() && (
          <p style={{ fontSize: 11, color: "#555", marginTop: 16, textAlign: "center" }}>Supabase URL not set — real login is disabled until it's configured.</p>
        )}
        {supabaseReady() && (
          <p style={{ fontSize: 11, color: "#555", marginTop: 16, textAlign: "center" }}>No account yet? Create one in Supabase → Authentication → Users.</p>
        )}
      </div>
    </div>
  );
}

function AdminDashboard({ session, onSignOut, onExit }) {
  const [tab, setTab] = useState("dashboard");
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dataSource, setDataSource] = useState("loading"); // loading | live | sample

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const res = await fetchLeads(session.accessToken);
      if (!active) return;
      if (res.ok && res.leads.length > 0) {
        setLeads(res.leads);
        setDataSource("live");
      } else {
        setLeads(generateMockLeads());
        setDataSource("sample");
      }
      setLoading(false);
    })();
    return () => { active = false; };
  }, [session.accessToken]);

  const metrics = computeMetrics(leads);

  const updateLeadLocal = async (id, patch) => {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    await patchLead(session.accessToken, id, patch);
  };

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "leads", label: "Leads", icon: Users },
    { id: "appointments", label: "Appointments", icon: Calendar },
    { id: "analytics", label: "Analytics", icon: BarChart3 },
    { id: "settings", label: "Settings", icon: SettingsIcon },
    { id: "profile", label: "Profile", icon: UserCircle },
  ];
  const activeItem = navItems.find((n) => n.id === tab);

  return (
    <div style={S.app}>
      <GlobalStyle />
      <Background />

      <div style={S.header}>
        <div style={S.logo}><span style={{ color: PRIMARY }}>⚡ </span>{gymName} <span style={{ color: SUBTEXT, fontWeight: 500, fontSize: 13 }}>Admin</span></div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12, color: SUBTEXT, display: "none" }} className="admin-email">{session.email}</span>
          <button
            style={{ ...S.badge, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, border: `1px solid ${BORDER}` }}
            onClick={onSignOut}
          >
            <LogOut size={12} /> Sign Out
          </button>
        </div>
      </div>

      <div className="admin-shell">
        <div className="admin-nav">
          {navItems.map((item) => (
            <div
              key={item.id}
              onClick={() => setTab(item.id)}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, cursor: "pointer",
                background: tab === item.id ? `${PRIMARY}15` : "transparent",
                color: tab === item.id ? PRIMARY : SUBTEXT,
                fontWeight: tab === item.id ? 700 : 500, fontSize: 13, whiteSpace: "nowrap",
              }}
            >
              <item.icon size={16} /> {item.label}
            </div>
          ))}
          <div
            onClick={onExit}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, cursor: "pointer", color: SUBTEXT, fontSize: 13, whiteSpace: "nowrap" }}
          >
            <ArrowLeft size={16} /> Visitor site
          </div>
        </div>

        <div className="admin-content">
          {tab === "dashboard" ? (
            <DashboardHome loading={loading} metrics={metrics} dataSource={dataSource} leads={leads} />
          ) : tab === "leads" ? (
            <LeadsPage leads={leads} loading={loading} onUpdateLead={updateLeadLocal} />
          ) : tab === "analytics" ? (
            <AnalyticsPage leads={leads} loading={loading} />
          ) : tab === "settings" ? (
            <SettingsPage session={session} />
          ) : (
            <EmptyState
              icon={activeItem.icon}
              title={`${activeItem.label} — coming in the next pass`}
              subtitle="This section is on the roadmap. Dashboard, Leads, Analytics, and Settings are fully live."
            />
          )}
        </div>
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="stat-grid">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{ ...S.card, minHeight: 92 }}>
          <div className="skel" style={{ width: 16, height: 16, borderRadius: 4, marginBottom: 14 }} />
          <div className="skel" style={{ width: "60%", height: 22, borderRadius: 6, marginBottom: 8 }} />
          <div className="skel" style={{ width: "80%", height: 10, borderRadius: 4 }} />
        </div>
      ))}
    </div>
  );
}

function StatusChip({ status }) {
  const map = {
    new: { bg: "#132133", fg: "#6FB8FF" },
    contacted: { bg: "#2a2410", fg: "#F8C15B" },
    booked: { bg: `${PRIMARY}20`, fg: PRIMARY },
    joined: { bg: "#102a18", fg: "#4ADE80" },
    lost: { bg: "#2a1414", fg: "#FF6B6B" },
  };
  const c = map[status] || map.new;
  return (
    <span style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 9px", borderRadius: 20, background: c.bg, color: c.fg, textTransform: "capitalize" }}>
      {status}
    </span>
  );
}

function EmptyState({ icon: Icon, title, subtitle }) {
  return (
    <div className="fadeUp" style={{ textAlign: "center", padding: "70px 20px", color: SUBTEXT }}>
      <div style={{ width: 56, height: 56, borderRadius: 16, background: GLASS, border: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
        <Icon size={24} color={PRIMARY} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: TEXT, marginBottom: 6, fontFamily: "'Space Grotesk',sans-serif" }}>{title}</div>
      <div style={{ fontSize: 12.5, maxWidth: 320, margin: "0 auto", lineHeight: 1.6 }}>{subtitle}</div>
    </div>
  );
}

function DashboardHome({ loading, metrics, dataSource, leads }) {
  if (loading) return <DashboardSkeleton />;

  const cards = [
    { label: "Today's Leads", value: metrics.today, icon: Sparkles },
    { label: "Weekly Leads", value: metrics.week, icon: TrendingUp },
    { label: "Monthly Leads", value: metrics.month, icon: Users },
    { label: "Conversion Rate", value: `${metrics.conversion}%`, icon: Target },
    { label: "Booked Consultations", value: metrics.booked, icon: Calendar },
    { label: "Revenue Estimate", value: `₹${metrics.revenue.toLocaleString()}`, icon: Wallet },
  ];

  return (
    <div className="fadeUp">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: dataSource === "live" ? PRIMARY : "#F8C15B" }} />
        <span style={{ fontSize: 12, color: SUBTEXT }}>
          {dataSource === "live" ? "Live data from Supabase" : "Sample data — no real leads in Supabase yet"}
        </span>
      </div>

      <div className="stat-grid">
        {cards.map((c, i) => (
          <div key={i} style={S.card}>
            <c.icon size={16} color={PRIMARY} style={{ marginBottom: 10 }} />
            <div style={{ fontSize: 24, fontWeight: 800, fontFamily: "'Space Grotesk',sans-serif" }}>{c.value}</div>
            <div style={{ fontSize: 12, color: SUBTEXT, marginTop: 4 }}>{c.label}</div>
          </div>
        ))}
      </div>

      <div style={S.card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={S.stepLabel}>Recent Leads</div>
          <span style={{ fontSize: 11, color: SUBTEXT }}>{leads.length} total</span>
        </div>
        {leads.slice(0, 6).map((l, i) => (
          <div key={l.id || i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: i < Math.min(5, leads.length - 1) ? `1px solid ${BORDER}` : "none" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{l.first_name} {l.last_name}</div>
              <div style={{ fontSize: 11, color: SUBTEXT }}>{l.goal} · BMI {l.bmi}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: PRIMARY }}>{l.lead_score ?? "—"}</span>
              <StatusChip status={l.status} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   LEADS PAGE — search, filter, sort, pagination, detail view
   ============================================================ */
function LeadsPage({ leads, loading, onUpdateLead }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest"); // newest | score | bmi
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState(null);
  const pageSize = 8;

  useEffect(() => { setPage(1); }, [search, statusFilter, sortBy]);

  if (loading) return <DashboardSkeleton />;

  const filtered = leads.filter((l) => {
    const q = search.trim().toLowerCase();
    const matchesSearch = !q
      || `${l.first_name} ${l.last_name}`.toLowerCase().includes(q)
      || (l.phone || "").toLowerCase().includes(q)
      || (l.email || "").toLowerCase().includes(q);
    const matchesStatus = statusFilter === "all" || l.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "score") return (b.lead_score || 0) - (a.lead_score || 0);
    if (sortBy === "bmi") return (a.bmi || 0) - (b.bmi || 0);
    return new Date(b.created_at) - new Date(a.created_at);
  });

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageSafe = Math.min(page, totalPages);
  const pageLeads = sorted.slice((pageSafe - 1) * pageSize, pageSafe * pageSize);
  const selectedLead = selectedId ? leads.find((l) => l.id === selectedId) : null;

  return (
    <div className="fadeUp">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ ...S.display, fontSize: 20, fontWeight: 700 }}>Leads</div>
          <div style={{ fontSize: 12, color: SUBTEXT, marginTop: 2 }}>{sorted.length} of {leads.length} total</div>
        </div>
        <div style={{ position: "relative", flex: "1 1 220px", maxWidth: 300 }}>
          <Search size={14} color={SUBTEXT} style={{ position: "absolute", left: 12, top: 12 }} />
          <input
            style={{ ...S.input, paddingLeft: 34, marginBottom: 0 }}
            placeholder="Search name, phone, email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["all", "new", "contacted", "booked", "joined", "lost"].map((s) => (
            <div key={s} style={{ ...S.pill(statusFilter === s), padding: "7px 13px", fontSize: 11.5 }} onClick={() => setStatusFilter(s)}>
              {s === "all" ? "All" : s[0].toUpperCase() + s.slice(1)}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[{ k: "newest", l: "Newest" }, { k: "score", l: "Highest Score" }, { k: "bmi", l: "Lowest BMI" }].map((o) => (
            <div key={o.k} style={{ ...S.pill(sortBy === o.k), padding: "7px 13px", fontSize: 11.5 }} onClick={() => setSortBy(o.k)}>{o.l}</div>
          ))}
        </div>
      </div>

      {sorted.length === 0 ? (
        <EmptyState icon={Users} title="No leads match your filters" subtitle="Try clearing the search box or switching the status filter back to All." />
      ) : (
        <>
          <div style={{ overflowX: "auto", border: `1px solid ${BORDER}`, borderRadius: 14 }}>
            <div style={{ minWidth: 740 }}>
              <div style={{ display: "flex", padding: "12px 16px", borderBottom: `1px solid ${BORDER}`, fontSize: 10.5, fontWeight: 700, color: SUBTEXT, textTransform: "uppercase", letterSpacing: 0.5 }}>
                <div style={{ flex: "2 0 0" }}>Name</div>
                <div style={{ flex: "1.5 0 0" }}>Phone</div>
                <div style={{ flex: "1.3 0 0" }}>Goal</div>
                <div style={{ flex: "0.7 0 0" }}>BMI</div>
                <div style={{ flex: "0.8 0 0" }}>Score</div>
                <div style={{ flex: "1 0 0" }}>Status</div>
                <div style={{ flex: "1.2 0 0" }}>Created</div>
                <div style={{ flex: "0.5 0 0", textAlign: "right" }} />
              </div>
              {pageLeads.map((l) => (
                <div
                  key={l.id}
                  className="lead-row"
                  onClick={() => setSelectedId(l.id)}
                  style={{ display: "flex", alignItems: "center", padding: "13px 16px", borderBottom: `1px solid ${BORDER}`, cursor: "pointer", fontSize: 12.5 }}
                >
                  <div style={{ flex: "2 0 0", fontWeight: 600 }}>{l.first_name} {l.last_name}</div>
                  <div style={{ flex: "1.5 0 0", color: SUBTEXT }}>{l.phone || "—"}</div>
                  <div style={{ flex: "1.3 0 0", color: "#ccc" }}>{l.goal || "—"}</div>
                  <div style={{ flex: "0.7 0 0", color: "#ccc" }}>{l.bmi ?? "—"}</div>
                  <div style={{ flex: "0.8 0 0", color: PRIMARY, fontWeight: 700 }}>{l.lead_score ?? "—"}</div>
                  <div style={{ flex: "1 0 0" }}><StatusChip status={l.status} /></div>
                  <div style={{ flex: "1.2 0 0", color: SUBTEXT }}>{formatDate(l.created_at)}</div>
                  <div style={{ flex: "0.5 0 0", textAlign: "right", color: SUBTEXT }}><ChevronRight size={15} /></div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, marginTop: 18 }}>
            <button
              style={{ ...S.btnS, width: "auto", padding: "8px 16px", marginTop: 0, opacity: pageSafe <= 1 ? 0.4 : 1, cursor: pageSafe <= 1 ? "default" : "pointer" }}
              disabled={pageSafe <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Prev
            </button>
            <span style={{ fontSize: 12, color: SUBTEXT }}>Page {pageSafe} of {totalPages}</span>
            <button
              style={{ ...S.btnS, width: "auto", padding: "8px 16px", marginTop: 0, opacity: pageSafe >= totalPages ? 0.4 : 1, cursor: pageSafe >= totalPages ? "default" : "pointer" }}
              disabled={pageSafe >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}

      {selectedLead && (
        <LeadDetail lead={selectedLead} onClose={() => setSelectedId(null)} onUpdateLead={onUpdateLead} />
      )}
    </div>
  );
}

function LeadDetail({ lead, onClose, onUpdateLead }) {
  const [notes, setNotes] = useState(lead.notes || "");
  const [savingNotes, setSavingNotes] = useState(false);
  const [savedPulse, setSavedPulse] = useState(false);

  const isMock = String(lead.id).startsWith("mock-");

  const saveNotes = async () => {
    setSavingNotes(true);
    await onUpdateLead(lead.id, { notes });
    setSavingNotes(false);
    setSavedPulse(true);
    setTimeout(() => setSavedPulse(false), 1500);
  };

  const setStatus = (status) => onUpdateLead(lead.id, { status });

  const waMessage = `Hi ${lead.first_name}, this is ${gymName} following up on your fitness assessment. Do you have a moment to talk about your free consultation?`;
  const waLink = `https://wa.me/${(lead.phone || "").replace(/[^\d]/g, "")}?text=${encodeURIComponent(waMessage)}`;

  const timelineText = lead.goal === "Lose Fat"
    ? "Visible change in 4-6 weeks, major transformation in 12-16 weeks"
    : lead.goal === "Build Muscle"
    ? "Strength gains in 3-6 weeks, visible growth in 10-14 weeks"
    : "Noticeable improvement in 4-8 weeks";

  const fields = [
    { label: "Body Score", value: lead.body_score ?? "—" },
    { label: "BMI", value: lead.bmi ? `${lead.bmi} (${lead.bmi_category || "—"})` : "—" },
    { label: "Goal", value: lead.goal || "—" },
    { label: "Lifestyle", value: lead.lifestyle || "—" },
    { label: "Workout Days", value: lead.workout_days ? `${lead.workout_days}/week` : "—" },
    { label: "Budget", value: lead.budget || "—" },
    { label: "Joining Intent", value: lead.joining_time || "—" },
    { label: "Timeline", value: timelineText },
  ];

  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={{ ...S.modalCard, maxWidth: 460, maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()} className="fadeUp">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
          <div>
            <div style={{ ...S.display, fontSize: 19, fontWeight: 700 }}>{lead.first_name} {lead.last_name}</div>
            <div style={{ fontSize: 11.5, color: SUBTEXT, marginTop: 2 }}>Submitted {formatDate(lead.created_at)}{lead.city ? ` · ${lead.city}` : ""}</div>
          </div>
          <span onClick={onClose} style={{ cursor: "pointer", color: SUBTEXT, padding: 4 }}><X size={18} /></span>
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "14px 0" }}>
          {["new", "contacted", "booked", "joined", "lost"].map((s) => (
            <div key={s} style={{ ...S.pill(lead.status === s), fontSize: 11, padding: "6px 12px" }} onClick={() => setStatus(s)}>
              {s[0].toUpperCase() + s.slice(1)}
            </div>
          ))}
        </div>

        <div style={{ ...S.card, background: "#0d0d0d", display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
          <CircularStat value={lead.body_score || 0} size={72} stroke={7} label="SCORE" />
          <div>
            <div style={{ fontSize: 11, color: SUBTEXT, marginBottom: 3 }}>Lead Score (admin only)</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: PRIMARY, fontFamily: "'Space Grotesk',sans-serif" }}>
              {lead.lead_score ?? "—"}<span style={{ fontSize: 13, color: SUBTEXT }}>/100</span>
            </div>
            {Array.isArray(lead.lead_score_reasons) && lead.lead_score_reasons.length > 0 && (
              <div style={{ fontSize: 10.5, color: "#999", marginTop: 2 }}>{lead.lead_score_reasons[0]}</div>
            )}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 14px", marginBottom: 18 }}>
          {fields.map((f) => (
            <div key={f.label}>
              <div style={{ fontSize: 10.5, color: SUBTEXT, marginBottom: 2, textTransform: "uppercase", letterSpacing: 0.4 }}>{f.label}</div>
              <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4 }}>{f.value}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          <a href={`tel:${lead.phone || ""}`} style={{ ...S.btnS, flex: 1, color: PRIMARY, borderColor: `${PRIMARY}40`, textDecoration: "none", marginTop: 0, padding: "10px 6px" }}>
            <Phone size={14} /> Call
          </a>
          <a href={waLink} target="_blank" rel="noopener noreferrer" style={{ ...S.btnS, flex: 1, color: PRIMARY, borderColor: `${PRIMARY}40`, textDecoration: "none", marginTop: 0, padding: "10px 6px" }}>
            <MessageCircle size={14} /> WhatsApp
          </a>
          <a href={`mailto:${lead.email || ""}`} style={{ ...S.btnS, flex: 1, color: PRIMARY, borderColor: `${PRIMARY}40`, textDecoration: "none", marginTop: 0, padding: "10px 6px" }}>
            <Mail size={14} /> Email
          </a>
        </div>

        <label style={S.label}>Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add a note about this lead..."
          rows={3}
          style={{ ...S.input, resize: "vertical", fontFamily: "inherit", marginBottom: 8, width: "100%" }}
        />
        <button style={{ ...S.btnP, marginTop: 0 }} onClick={saveNotes} disabled={savingNotes}>
          {savingNotes
            ? <><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Saving...</>
            : savedPulse
            ? <><CheckCircle2 size={14} /> Saved</>
            : "Save Notes"}
        </button>
        {isMock && <p style={{ fontSize: 10.5, color: "#555", textAlign: "center", marginTop: 10 }}>Sample lead — changes here aren't written to Supabase.</p>}
      </div>
    </div>
  );
}

/* ============================================================
   ANALYTICS
   ============================================================ */
const tooltipStyle = { background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, fontSize: 12, padding: "8px 10px" };

function ChartCard({ title, subtitle, children }) {
  return (
    <div style={{ ...S.card, marginBottom: 14 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 11, color: SUBTEXT, marginTop: 2 }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function FunnelViz({ stages }) {
  const max = stages[0]?.count || 1;
  return (
    <div>
      {stages.map((s, i) => {
        const pct = max ? Math.round((s.count / max) * 100) : 0;
        return (
          <div key={s.label} style={{ marginBottom: i < stages.length - 1 ? 14 : 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
              <span style={{ color: "#ccc", fontWeight: 600 }}>{s.label}</span>
              <span style={{ color: SUBTEXT }}>{s.count} · {pct}%</span>
            </div>
            <div style={{ height: 10, background: MUTED, borderRadius: 6, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${pct}%`, background: PRIMARY, opacity: 1 - i * 0.15, borderRadius: 6, transition: "width 1s cubic-bezier(.22,1,.36,1)" }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SourceViz({ leads }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: "#ccc", fontWeight: 600 }}>AI Assessment Tool (on-site)</span>
        <span style={{ fontSize: 12, color: PRIMARY, fontWeight: 700 }}>{leads.length} · 100%</span>
      </div>
      <div style={{ height: 10, background: MUTED, borderRadius: 6, overflow: "hidden", marginBottom: 10 }}>
        <div style={{ height: "100%", width: "100%", background: PRIMARY, borderRadius: 6 }} />
      </div>
      <p style={{ fontSize: 11, color: "#555", margin: 0, lineHeight: 1.5 }}>
        Every lead currently comes through your assessment tool. Add UTM/referrer tracking in a future pass to break this down by channel (Instagram, Google, walk-in QR, etc).
      </p>
    </div>
  );
}

function AnalyticsPage({ leads, loading }) {
  if (loading) return <DashboardSkeleton />;

  const daily = computeDailySeries(leads, 14);
  const monthly = computeMonthlySeries(leads, 6);
  const funnel = computeFunnel(leads);
  const goalDist = computeDistribution(leads, "goal", ["Lose Fat", "Build Muscle", "Weight Gain", "Strength", "General Fitness"]);
  const bmiDist = computeBmiDistribution(leads);
  const ageDist = computeAgeDistribution(leads);

  const axisProps = { tick: { fill: SUBTEXT, fontSize: 10 }, axisLine: { stroke: BORDER }, tickLine: false };

  return (
    <div className="fadeUp">
      <div style={{ ...S.display, fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Analytics</div>
      <div style={{ fontSize: 12, color: SUBTEXT, marginBottom: 20 }}>Based on {leads.length} leads</div>

      <ChartCard title="Daily Leads" subtitle="Last 14 days">
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={daily}>
            <CartesianGrid stroke="#1c1c1c" vertical={false} />
            <XAxis dataKey="label" {...axisProps} interval={1} />
            <YAxis allowDecimals={false} {...axisProps} axisLine={false} width={22} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: TEXT }} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
            <Bar dataKey="count" fill={PRIMARY} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Monthly Leads" subtitle="Last 6 months">
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={monthly}>
            <CartesianGrid stroke="#1c1c1c" vertical={false} />
            <XAxis dataKey="label" {...axisProps} />
            <YAxis allowDecimals={false} {...axisProps} axisLine={false} width={22} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: TEXT }} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
            <Bar dataKey="count" fill={AI_GLOW} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Conversion Funnel" subtitle="From first contact to member">
        <FunnelViz stages={funnel} />
      </ChartCard>

      <ChartCard title="Lead Sources">
        <SourceViz leads={leads} />
      </ChartCard>

      <ChartCard title="Goal Distribution">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={goalDist} layout="vertical" margin={{ left: 8, right: 12 }}>
            <CartesianGrid stroke="#1c1c1c" horizontal={false} />
            <XAxis type="number" allowDecimals={false} {...axisProps} axisLine={false} />
            <YAxis type="category" dataKey="label" width={104} tick={{ fill: "#ccc", fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
            <Bar dataKey="count" fill={PRIMARY} radius={[0, 4, 4, 0]} barSize={16} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <ChartCard title="BMI Distribution">
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={bmiDist}>
                <CartesianGrid stroke="#1c1c1c" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: SUBTEXT, fontSize: 9.5 }} axisLine={{ stroke: BORDER }} tickLine={false} />
                <YAxis allowDecimals={false} {...axisProps} axisLine={false} width={22} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
                <Bar dataKey="count" fill="#F8C15B" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <ChartCard title="Age Distribution">
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={ageDist}>
                <CartesianGrid stroke="#1c1c1c" vertical={false} />
                <XAxis dataKey="label" {...axisProps} />
                <YAxis allowDecimals={false} {...axisProps} axisLine={false} width={22} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
                <Bar dataKey="count" fill="#6FB8FF" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   SETTINGS
   ============================================================ */
function Toggle({ checked, onChange }) {
  return (
    <div
      onClick={onChange}
      style={{
        width: 36, height: 20, borderRadius: 20, cursor: "pointer", flexShrink: 0,
        background: checked ? PRIMARY : MUTED, border: `1px solid ${checked ? PRIMARY : BORDER}`,
        display: "flex", alignItems: "center", padding: 2, transition: "background .2s",
      }}
    >
      <div style={{ width: 14, height: 14, borderRadius: "50%", background: checked ? DARK : SUBTEXT, transform: checked ? "translateX(16px)" : "translateX(0)", transition: "transform .2s" }} />
    </div>
  );
}

function AutomationTimeline({ message }) {
  const [enabled, setEnabled] = useState({ t0: true, d1: true, d3: true, d5: true, d7: true });
  const steps = [
    { key: "t0", when: "Immediately", title: "Thank You Message", desc: message ? `"${message.slice(0, 70)}${message.length > 70 ? "…" : ""}"` : "Sent right after the assessment completes.", icon: CheckCircle2 },
    { key: "d1", when: "Day 1", title: "Workout Tips", desc: "A quick tip matched to their goal, to keep momentum going.", icon: Dumbbell },
    { key: "d3", when: "Day 3", title: "Nutrition Advice", desc: "A practical nutrition tip tied to their diet preference.", icon: Flame },
    { key: "d5", when: "Day 5", title: "Success Story", desc: "A relevant transformation story for social proof.", icon: TrendingUp },
    { key: "d7", when: "Day 7", title: "Free Trial Reminder", desc: "A nudge to book before the free offer feels stale.", icon: Sparkles },
  ];

  return (
    <div style={S.card}>
      <div style={S.stepLabel}>Automated Follow-Ups</div>
      <p style={{ fontSize: 11.5, color: SUBTEXT, marginBottom: 20, marginTop: -4, lineHeight: 1.5 }}>
        The sequence every lead follows after their assessment. Actually sending these isn't wired up yet — this defines the plan for when it is.
      </p>
      <div>
        {steps.map((s, i) => (
          <div key={s.key} style={{ display: "flex", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{
                width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
                background: enabled[s.key] ? `${PRIMARY}20` : MUTED,
                border: `1px solid ${enabled[s.key] ? PRIMARY + "50" : BORDER}`,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <s.icon size={14} color={enabled[s.key] ? PRIMARY : SUBTEXT} />
              </div>
              {i < steps.length - 1 && <div style={{ width: 2, flex: 1, background: BORDER, minHeight: 30, marginTop: 4 }} />}
            </div>
            <div style={{ flex: 1, paddingBottom: i < steps.length - 1 ? 22 : 0, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                <div>
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: PRIMARY, textTransform: "uppercase", letterSpacing: 0.5 }}>{s.when}</span>
                  <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>{s.title}</div>
                </div>
                <Toggle checked={enabled[s.key]} onChange={() => setEnabled((e) => ({ ...e, [s.key]: !e[s.key] }))} />
              </div>
              <div style={{ fontSize: 11.5, color: SUBTEXT, marginTop: 4, lineHeight: 1.5 }}>{s.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsPage({ session }) {
  const [form, setForm] = useState({
    gym_name: gymName, logo_url: "", contact_number: "", whatsapp_number: GYM_WHATSAPP_NUMBER,
    contact_email: "", address: "", brand_color: PRIMARY, consultation_message: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedPulse, setSavedPulse] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [source, setSource] = useState("loading"); // loading | live | local

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await fetchProfile(session.accessToken);
      if (!active) return;
      if (res.ok && res.profile) {
        setForm((f) => ({ ...f, ...res.profile }));
        setSource("live");
      } else {
        setSource("local");
      }
      setLoading(false);
    })();
    return () => { active = false; };
  }, [session.accessToken]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    setSaveError(false);
    const res = await saveProfile(session.accessToken, form);
    setSaving(false);
    if (res.ok) {
      setSavedPulse(true);
      setTimeout(() => setSavedPulse(false), 1500);
    } else if (!res.skipped) {
      setSaveError(true);
      setTimeout(() => setSaveError(false), 2500);
    }
  };

  if (loading) return <DashboardSkeleton />;

  return (
    <div className="fadeUp">
      <div style={{ ...S.display, fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Settings</div>
      <div style={{ fontSize: 12, color: SUBTEXT, marginBottom: 20 }}>
        {source === "live" ? "Synced with Supabase" : "gym_profile table not found — edits stay in this session until it's created"}
      </div>

      <div style={S.card}>
        <div style={S.stepLabel}>Gym Profile</div>
        <label style={S.label}>Gym Name</label>
        <input style={S.input} value={form.gym_name || ""} onChange={set("gym_name")} />

        <label style={S.label}>Logo URL</label>
        <input style={S.input} value={form.logo_url || ""} onChange={set("logo_url")} placeholder="https://..." />

        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Contact Number</label>
            <input style={S.input} value={form.contact_number || ""} onChange={set("contact_number")} placeholder="+91 98765 43210" />
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.label}>WhatsApp Number</label>
            <input style={S.input} value={form.whatsapp_number || ""} onChange={set("whatsapp_number")} placeholder="911234567890" />
          </div>
        </div>

        <label style={S.label}>Email</label>
        <input style={S.input} value={form.contact_email || ""} onChange={set("contact_email")} placeholder="owner@powerfitgym.com" />

        <label style={S.label}>Address</label>
        <input style={S.input} value={form.address || ""} onChange={set("address")} placeholder="123 Fitness Street, Mumbai" />

        <label style={S.label}>Brand Colour</label>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <input
            type="color"
            value={/^#[0-9A-Fa-f]{6}$/.test(form.brand_color || "") ? form.brand_color : PRIMARY}
            onChange={set("brand_color")}
            style={{ width: 44, height: 38, padding: 2, border: `1px solid ${BORDER}`, borderRadius: 8, background: MUTED, cursor: "pointer" }}
          />
          <input style={{ ...S.input, marginBottom: 0, flex: 1 }} value={form.brand_color || ""} onChange={set("brand_color")} placeholder="#C8F135" />
        </div>
        <p style={{ fontSize: 10.5, color: "#555", marginTop: 0, marginBottom: 14 }}>Saved with your profile now; applying it across the visitor site is a future pass.</p>

        <label style={S.label}>Consultation Message</label>
        <textarea
          rows={3}
          style={{ ...S.input, resize: "vertical", fontFamily: "inherit" }}
          value={form.consultation_message || ""}
          onChange={set("consultation_message")}
          placeholder="What we'll say when we follow up with a new lead..."
        />

        <button style={S.btnP} onClick={save} disabled={saving}>
          {saving
            ? <><Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> Saving...</>
            : savedPulse
            ? <><CheckCircle2 size={15} /> Saved</>
            : saveError
            ? "Couldn't save — check the SQL setup"
            : "Save Settings"}
        </button>
      </div>

      <AutomationTimeline message={form.consultation_message} />
    </div>
  );
}
