export function dateKeyOnly(slot) {
  const key = String(slot?.key || "");
  const m = key.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export function parseTimeToMinutes(timeText) {
  if (!timeText) return Number.POSITIVE_INFINITY;
  const m = String(timeText).match(/\b(\d{1,2})\s*[:h]\s*(\d{2})\b/i);
  if (!m) return Number.POSITIVE_INFINITY;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export function slotSortValue(slot) {
  const key = String(slot?.key || "");
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return Number.POSITIVE_INFINITY;

  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  const mins = parseTimeToMinutes(slot?.time);
  const hour = Number.isFinite(mins) ? Math.floor(mins / 60) : 23;
  const minute = Number.isFinite(mins) ? mins % 60 : 59;
  return Date.UTC(year, month, day, hour, minute, 0, 0);
}

export function sortSlots(slots = []) {
  return [...slots].sort((a, b) => {
    const av = slotSortValue(a);
    const bv = slotSortValue(b);
    if (av !== bv) return av - bv;
    if (a?.time && !b?.time) return -1;
    if (!a?.time && b?.time) return 1;
    return String(a?.label || "").localeCompare(String(b?.label || ""));
  });
}

export function earliestSlot(slots = []) {
  return sortSlots(slots)[0] || null;
}

export function uniqueDateKeys(slots = []) {
  return [...new Set(slots.map(dateKeyOnly).filter(Boolean))].sort();
}

export function targetDateKeys(slots = [], urgentEndDate) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Brussels" });
  return uniqueDateKeys(slots).filter(k => k >= today && k <= urgentEndDate);
}

export function computeAlertDecision(previousState, slots, urgentEndDate) {
  const prevEarliest = previousState?.lastEarliestDateKey || null;
  const earliest = earliestSlot(slots);
  const currentEarliest = earliest ? dateKeyOnly(earliest) : null;

  const previousActiveTargets = new Set(previousState?.activeTargetDateKeys || []);
  const currentTargets = targetDateKeys(slots, urgentEndDate);
  const newTargetDates = currentTargets.filter(k => !previousActiveTargets.has(k));

  const appearedFromNothing = !!currentEarliest && !prevEarliest;
  const earliestImproved = !!currentEarliest && !!prevEarliest && currentEarliest < prevEarliest;

  return {
    earliest,
    currentEarliest,
    currentTargets,
    newTargetDates,
    appearedFromNothing,
    earliestImproved,
    shouldPushUrgent: newTargetDates.length > 0 || appearedFromNothing || earliestImproved,
    shouldEmailUrgent: newTargetDates.length > 0
  };
}

export function availabilityFingerprint(slots = [], dates = []) {
  const s = sortSlots(slots).map(x => `${x.key || ""}|${x.time || ""}|${x.label || ""}`);
  const d = [...dates].map(x => `${x.key || ""}|${x.label || ""}`).sort();
  return JSON.stringify({s, d});
}

export function formatSlot(slot) {
  if (!slot) return "No appointment currently detected";
  const date = slot.date || slot.label || dateKeyOnly(slot) || "Available appointment";
  return `${date}${slot.time ? ` — ${slot.time}` : ""}`;
}
