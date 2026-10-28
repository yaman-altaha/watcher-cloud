import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import {
  availabilityFingerprint,
  computeAlertDecision,
  dateKeyOnly,
  formatSlot,
  sortSlots
} from "./logic.mjs";
import { sendNtfy, sendUrgentEmail } from "./notify.mjs";

const TARGET = "https://rendez-vous.liege.be/nationalites";
const HORIZON_MONTHS = Number(process.env.HORIZON_MONTHS || 24);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const URGENT_END_DATE = String(process.env.URGENT_END_DATE || "2027-01-31");
const STATE_PATH = path.resolve(process.env.STATE_PATH || "docs/state.json");
const SCREENSHOT_PATH = path.resolve(process.env.SCREENSHOT_PATH || "watcher-failure.png");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function nowIso() { return new Date().toISOString(); }
function monthKeyBrussels() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Brussels", year: "numeric", month: "2-digit"
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  return `${y}-${m}`;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); }
  catch { return {}; }
}

function writeState(s) {
  fs.mkdirSync(path.dirname(STATE_PATH), {recursive:true});
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n");
}

async function bestFrame(page) {
  const candidates = [];
  for (const frame of page.frames()) {
    try {
      const data = await frame.evaluate(() => {
        const body = (document.body?.innerText || "").toLowerCase();
        const datepickers = document.querySelectorAll(".ui-datepicker, .ui-datepicker-calendar").length;
        const dateInputs = [
          ...document.querySelectorAll("input.hasDatepicker"),
          ...document.querySelectorAll('input[id*="date" i], input[name*="date" i]')
        ].length;
        let score = datepickers * 20 + dateInputs * 8;
        if (body.includes("créneau horaire")) score += 12;
        if (body.includes("creneau horaire")) score += 12;
        if (body.includes("place and date")) score += 5;
        if (body.includes("informations générales")) score += 5;
        if (body.includes("nationalit")) score += 2;
        return {score, datepickers, dateInputs, href:location.href, title:document.title};
      });
      candidates.push({frame, ...data});
    } catch {}
  }
  candidates.sort((a,b) => (b.score || 0) - (a.score || 0));
  if (!candidates.length || (candidates[0].score || 0) <= 0) {
    throw new Error("Appointment form/frame not found.");
  }
  return candidates[0];
}

async function deepScan(frame, horizonMonths) {
  return await frame.evaluate(async (horizonMonths) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const clean = s => (s || "").replace(/\s+/g, " ").trim();
    const MONTHS = [
      "janvier","février","mars","avril","mai","juin",
      "juillet","août","septembre","octobre","novembre","décembre"
    ];
    const normMonth = s => clean(s).toLowerCase()
      .replace("fevrier","février").replace("aout","août").replace("decembre","décembre");

    function visible(el) {
      if (!el) return false;
      const cs = getComputedStyle(el);
      const rr = el.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0" && rr.width > 0 && rr.height > 0;
    }

    function dateInput() {
      const direct = [
        ...document.querySelectorAll("input.hasDatepicker"),
        ...document.querySelectorAll('input[id*="date" i], input[name*="date" i]')
      ].filter(visible);
      if (direct.length) return direct[0];
      for (const lab of document.querySelectorAll("label")) {
        if (!/\bdate\b/i.test(clean(lab.textContent))) continue;
        const id = lab.getAttribute("for");
        if (id) {
          const el = document.getElementById(id);
          if (el?.tagName === "INPUT" && visible(el)) return el;
        }
        const row = lab.closest("tr,.row,.form-group,div");
        const el = row?.querySelector("input");
        if (el && visible(el)) return el;
      }
      return null;
    }

    function picker() { return [...document.querySelectorAll(".ui-datepicker")].find(visible) || null; }

    async function openPicker() {
      let dp = picker();
      if (dp) return dp;
      const input = dateInput();
      if (!input) throw new Error("Date field not found.");
      try { input.focus(); } catch {}
      try { input.click(); } catch {}
      for (const type of ["mousedown","mouseup","click"]) {
        input.dispatchEvent(new MouseEvent(type, {bubbles:true,cancelable:true}));
      }
      for (let i=0;i<30;i++) {
        await sleep(120);
        dp = picker();
        if (dp) return dp;
      }
      throw new Error("Calendar did not open.");
    }

    function monthYear(dp) {
      const mt = clean(dp.querySelector(".ui-datepicker-month")?.textContent);
      const yt = clean(dp.querySelector(".ui-datepicker-year")?.textContent);
      const mi = MONTHS.indexOf(normMonth(mt));
      const yr = parseInt(yt, 10);
      if (mi >= 0 && Number.isFinite(yr)) return {month:mi, year:yr};
      const title = clean(dp.querySelector(".ui-datepicker-title")?.textContent);
      const m = title.match(/(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(20\d{2})/i);
      if (!m) return null;
      const m2 = MONTHS.indexOf(normMonth(m[1]));
      const y2 = parseInt(m[2],10);
      return (m2 >= 0 && Number.isFinite(y2)) ? {month:m2,year:y2} : null;
    }

    function days(dp) {
      const h = monthYear(dp);
      if (!h) return [];
      const out = [];
      for (const td of dp.querySelectorAll(".ui-datepicker-calendar td")) {
        const cls = String(td.className || "");
        if (/ui-datepicker-unselectable|ui-state-disabled|ui-datepicker-other-month/.test(cls)) continue;
        const a = td.querySelector("a");
        if (!a || !visible(a)) continue;
        const day = parseInt(clean(a.textContent),10);
        if (!Number.isFinite(day) || day < 1 || day > 31) continue;
        let month = parseInt(td.getAttribute("data-month"),10);
        let year = parseInt(td.getAttribute("data-year"),10);
        if (!Number.isFinite(month)) month = h.month;
        if (!Number.isFinite(year)) year = h.year;
        out.push({
          day,month,year,
          key:`${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`,
          label:`${day} ${MONTHS[month]} ${year}`
        });
      }
      return out;
    }

    async function move(dp, dir) {
      const b = dp.querySelector(dir > 0 ? ".ui-datepicker-next" : ".ui-datepicker-prev");
      if (!b) return false;
      if (/ui-state-disabled/.test(String(b.className || "")) || b.getAttribute("aria-disabled") === "true") return false;
      const before = monthYear(dp);
      b.click();
      for (let i=0;i<30;i++) {
        await sleep(100);
        const p = picker();
        const after = p && monthYear(p);
        if (before && after && (before.month !== after.month || before.year !== after.year)) return true;
      }
      return false;
    }

    async function gotoMonth(year,month) {
      let dp = await openPicker();
      for (let i=0;i<40;i++) {
        dp = picker() || dp;
        const cur = monthYear(dp);
        if (!cur) throw new Error("Cannot read calendar month.");
        const a = cur.year*12 + cur.month;
        const b = year*12 + month;
        if (a === b) return dp;
        if (!await move(dp,b>a?1:-1)) throw new Error(`Cannot navigate to ${month+1}/${year}.`);
      }
      throw new Error("Calendar navigation safety limit reached.");
    }

    function timeSelect() {
      for (const lab of document.querySelectorAll("label")) {
        if (!/créneau|creneau|horaire|heure/i.test(clean(lab.textContent))) continue;
        const id = lab.getAttribute("for");
        if (id) {
          const s = document.getElementById(id);
          if (s?.tagName === "SELECT") return s;
        }
        const row = lab.closest("tr,.row,.form-group,div");
        const s = row?.querySelector("select");
        if (s) return s;
      }
      const all = [...document.querySelectorAll("select")].filter(visible);
      return all.find(s => [...s.options].some(o => /\b(?:[01]?\d|2[0-3])[:h][0-5]\d\b/.test(clean(o.textContent)))) || null;
    }

    function times(s) {
      if (!s) return [];
      return [...s.options].filter(o => !o.disabled).map(o => clean(o.textContent)).filter(t =>
        t && !/choisir|sélection|selection|aucun|indisponible|complet|^-+$/.test(t.toLowerCase()) &&
        /\b(?:[01]?\d|2[0-3])[:h][0-5]\d\b/.test(t)
      );
    }

    async function selectDate(d) {
      const dp = await gotoMonth(d.year,d.month);
      let target = null;
      for (const td of dp.querySelectorAll(".ui-datepicker-calendar td")) {
        const cls = String(td.className || "");
        if (/ui-datepicker-unselectable|ui-state-disabled|ui-datepicker-other-month/.test(cls)) continue;
        const a = td.querySelector("a");
        if (!a) continue;
        const day = parseInt(clean(a.textContent),10);
        let mo = parseInt(td.getAttribute("data-month"),10);
        let yr = parseInt(td.getAttribute("data-year"),10);
        if (!Number.isFinite(mo)) mo = d.month;
        if (!Number.isFinite(yr)) yr = d.year;
        if (day===d.day && mo===d.month && yr===d.year) { target=a; break; }
      }
      if (!target) throw new Error(`Enabled date disappeared: ${d.label}`);
      const before = timeSelect();
      const beforeKey = before ? [...before.options].map(o=>clean(o.textContent)).join("|") : "";
      target.click();
      for (let i=0;i<30;i++) {
        await sleep(120);
        const s = timeSelect();
        const tt = times(s);
        if (tt.length) return tt;
        if (s) {
          const now = [...s.options].map(o=>clean(o.textContent)).join("|");
          if (now && now !== beforeKey && i > 5) return [];
        }
      }
      return [];
    }

    let dp = await openPicker();
    const discovered = new Map();
    const visited = [];
    let monthsScanned = 0;

    for (let i=0;i<horizonMonths;i++) {
      dp = picker() || dp;
      const h = monthYear(dp);
      if (!h) break;
      const mk = `${h.year}-${String(h.month+1).padStart(2,"0")}`;
      if (visited.includes(mk)) break;
      visited.push(mk);
      for (const d of days(dp)) discovered.set(d.key,d);
      monthsScanned++;
      if (!await move(dp,1)) break;
    }

    const dates = [...discovered.values()].sort((a,b)=>a.key.localeCompare(b.key));
    const slots = [];
    const dateResults = [];
    const MAX_DEEP_DATES = 50;

    for (const d of dates.slice(0,MAX_DEEP_DATES)) {
      try {
        const tt = await selectDate(d);
        dateResults.push({date:d.label,times:tt});
        if (tt.length) {
          for (const t of tt) slots.push({key:`${d.key}|${t}`,date:d.label,time:t,label:`${d.label} — ${t}`});
        } else {
          slots.push({key:`${d.key}|DATE_ONLY`,date:d.label,time:null,label:d.label});
        }
      } catch (e) {
        dateResults.push({date:d.label,times:[],error:String(e)});
        slots.push({key:`${d.key}|DATE_ONLY`,date:d.label,time:null,label:d.label});
      }
    }
    for (const d of dates.slice(MAX_DEEP_DATES)) {
      slots.push({key:`${d.key}|DATE_ONLY`,date:d.label,time:null,label:d.label});
    }

    return {
      ok:true,
      pageUrl:location.href,
      monthsScanned,
      visitedMonths:visited,
      dates:dates.map(d=>({key:d.key,label:d.label})),
      slots,
      dateResults
    };
  }, horizonMonths);
}

async function oneAttempt(browser) {
  const context = await browser.newContext({
    locale: "fr-BE",
    timezoneId: "Europe/Brussels",
    viewport: {width:1280,height:900}
  });
  const page = await context.newPage();
  try {
    await page.goto(TARGET, {waitUntil:"domcontentloaded", timeout:30000});
    await sleep(1800);
    const candidate = await bestFrame(page);
    const result = await deepScan(candidate.frame,HORIZON_MONTHS);
    return {...result,frameInfo:{href:candidate.href,title:candidate.title,score:candidate.score}};
  } catch (e) {
    try { await page.screenshot({path:SCREENSHOT_PATH,fullPage:true}); } catch {}
    throw e;
  } finally {
    await context.close();
  }
}

function targetSlots(slots, dateKeys) {
  const set = new Set(dateKeys);
  return sortSlots(slots).filter(s => set.has(dateKeyOnly(s)));
}

async function main() {
  const previous = readState();
  const browser = await chromium.launch({headless:true});
  let result = null;
  let lastError = null;

  try {
    for (let attempt=1; attempt<=MAX_RETRIES; attempt++) {
      try {
        result = await oneAttempt(browser);
        break;
      } catch (e) {
        lastError = e;
        console.error(`Attempt ${attempt}/${MAX_RETRIES} failed:`, String(e));
        if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
      }
    }
  } finally {
    await browser.close();
  }

  if (!result) {
    const failures = Math.min(3, Number(previous.consecutiveFailures || 0) + 1);
    const next = {
      ...previous,
      schemaVersion:3,
      urgentEndDate:URGENT_END_DATE,
      consecutiveFailures:failures,
      lastError:String(lastError || "Unknown scan error"),
      heartbeatMonth: previous.heartbeatMonth || monthKeyBrussels()
    };

    if (failures === 3 && Number(previous.consecutiveFailures || 0) < 3) {
      try {
        await sendNtfy(
          "⚠️ Liège cloud watcher needs attention",
          "Three consecutive cloud scans failed. The local Chrome watcher can still continue when your PC is on. Open the mobile dashboard/GitHub Actions for details.",
          {priority:4}
        );
      } catch (e) { console.error("Health ntfy failed:",String(e)); }
      next.lastHealthAlertAt = nowIso();
    }

    writeState(next);
    process.exitCode = 2;
    return;
  }

  const slots = sortSlots(result.slots || []);
  const dates = result.dates || [];
  const decision = computeAlertDecision(previous,slots,URGENT_END_DATE);
  const fingerprint = availabilityFingerprint(slots,dates);
  const previousFingerprint = previous.availabilityFingerprint || null;
  const changed = fingerprint !== previousFingerprint;

  if (decision.shouldPushUrgent) {
    let title = "Liège appointment update";
    let body = "";

    if (decision.newTargetDates.length) {
      title = "🚨 Liège appointment in your target window!";
      const matches = targetSlots(slots,decision.newTargetDates);
      body = `Appointment date detected on/before ${URGENT_END_DATE}:\n` +
        matches.slice(0,10).map(x => `• ${formatSlot(x)}`).join("\n") +
        "\n\nOpen the booking page immediately.";
    } else if (decision.appearedFromNothing) {
      title = "🚨 Liège appointment available!";
      body = `Current earliest: ${formatSlot(decision.earliest)}. Open the booking page now.`;
    } else if (decision.earliestImproved) {
      title = "🚨 Earlier Liège appointment found!";
      body = `New earliest: ${formatSlot(decision.earliest)}. Open the booking page now.`;
    }

    try { await sendNtfy(title,body,{priority:5}); }
    catch (e) { console.error("Urgent ntfy failed:",String(e)); }

    if (decision.shouldEmailUrgent) {
      try { await sendUrgentEmail(title,body); }
      catch (e) { console.error("Urgent email failed:",String(e)); }
    }
  }

  const next = {
    ...previous,
    schemaVersion:3,
    urgentEndDate:URGENT_END_DATE,
    availabilityFingerprint:fingerprint,
    lastEarliestDateKey:decision.currentEarliest,
    lastEarliestLabel:decision.earliest?.date || decision.earliest?.label || null,
    lastEarliestTime:decision.earliest?.time || null,
    activeTargetDateKeys:decision.currentTargets,
    slots,
    dates,
    monthsScanned:result.monthsScanned,
    consecutiveFailures:0,
    lastError:null,
    heartbeatMonth:monthKeyBrussels()
  };

  if (changed) next.lastAvailabilityChangeAt = nowIso();
  if (previous.heartbeatMonth !== next.heartbeatMonth) next.monthlyHeartbeatAt = nowIso();

  writeState(next);

  console.log(JSON.stringify({
    ok:true,
    earliest:decision.earliest ? formatSlot(decision.earliest) : null,
    slots:slots.length,
    dates:dates.length,
    targetDates:decision.currentTargets,
    availabilityChanged:changed,
    monthsScanned:result.monthsScanned
  }, null, 2));
}

await main();
