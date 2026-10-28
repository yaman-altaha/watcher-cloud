import test from "node:test";
import assert from "node:assert/strict";
import { computeAlertDecision, earliestSlot, targetDateKeys } from "../src/logic.mjs";

const s = (date,time="08:00") => ({key:`${date}|${time}`,date,time,label:`${date} — ${time}`});

test("sorts earliest appointment by date", () => {
  assert.equal(earliestSlot([s("2027-03-22"),s("2027-01-15")]).key.startsWith("2027-01-15"), true);
});

test("time-only change on same date is not an urgent improvement", () => {
  const d = computeAlertDecision(
    {lastEarliestDateKey:"2027-03-22",activeTargetDateKeys:[]},
    [s("2027-03-22","11:00")],
    "2027-01-31"
  );
  assert.equal(d.earliestImproved,false);
  assert.equal(d.shouldPushUrgent,false);
});

test("earlier date triggers urgent push", () => {
  const d = computeAlertDecision(
    {lastEarliestDateKey:"2027-03-22",activeTargetDateKeys:[]},
    [s("2027-02-15")],
    "2027-01-31"
  );
  assert.equal(d.earliestImproved,true);
  assert.equal(d.shouldPushUrgent,true);
});

test("target-window date triggers push and email", () => {
  const d = computeAlertDecision(
    {lastEarliestDateKey:"2027-03-22",activeTargetDateKeys:[]},
    [s("2026-12-18"),s("2027-03-22")],
    "2027-01-31"
  );
  assert.deepEqual(d.newTargetDates,["2026-12-18"]);
  assert.equal(d.shouldPushUrgent,true);
  assert.equal(d.shouldEmailUrgent,true);
});

test("same target date does not repeat alert", () => {
  const d = computeAlertDecision(
    {lastEarliestDateKey:"2026-12-18",activeTargetDateKeys:["2026-12-18"]},
    [s("2026-12-18","09:00")],
    "2027-01-31"
  );
  assert.deepEqual(d.newTargetDates,[]);
  assert.equal(d.shouldEmailUrgent,false);
});

test("reappearing target date alerts again", () => {
  const d = computeAlertDecision(
    {lastEarliestDateKey:"2027-03-22",activeTargetDateKeys:[]},
    [s("2026-12-18")],
    "2027-01-31"
  );
  assert.deepEqual(d.newTargetDates,["2026-12-18"]);
});

test("targetDateKeys excludes dates after urgent end", () => {
  const keys = targetDateKeys([s("2027-01-15"),s("2027-02-01")],"2027-01-31");
  assert.equal(keys.includes("2027-02-01"),false);
});
