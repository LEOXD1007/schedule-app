import assert from "node:assert/strict";
import test from "node:test";
import {
  DUE_WINDOW_MS,
  dueReminders,
  isExpiredSubscription,
  markSent,
  mergeReminders,
  normalizeReminder,
  normalizeReminders,
  pruneReminders,
  reminderKey,
  unmarkSent,
} from "../src/schedule.js";

const NOW = Date.parse("2026-11-02T06:00:00.000Z");

function item(overrides) {
  const reminder = {
    id: "evt1",
    title: "项目周会",
    body: "09:00 – 10:00",
    date: "2026-11-02",
    allDay: false,
    start: "09:00",
    reminder: 10,
    fireAt: NOW - 60_000,
    ...overrides,
  };
  reminder.key = reminderKey(reminder);
  return reminder;
}

test("reminder key matches the in-app formula and changes when the schedule changes", () => {
  const timed = item({});
  assert.equal(reminderKey(timed), "evt1@2026-11-0209:00#10");
  assert.equal(reminderKey({ ...timed, allDay: true, start: "" }), "evt1@2026-11-02#10");
  assert.equal(reminderKey({ ...timed, reminder: 30 }), "evt1@2026-11-0209:00#30");
  assert.equal(reminderKey({ ...timed, start: "09:30" }), "evt1@2026-11-0209:30#10");
});

test("normalizeReminder drops events with no reminder and rebuilds the key", () => {
  const ok = normalizeReminder({ ...item({}), key: "client-supplied" }, NOW);
  assert.equal(ok.key, "evt1@2026-11-0209:00#10");
  assert.equal(normalizeReminder({ ...item({}), reminder: -1 }, NOW), null);
  assert.equal(normalizeReminder({ ...item({}), allDay: false, start: "" }, NOW), null);
  assert.ok(normalizeReminder({ ...item({ allDay: true, start: "" }), reminder: 0 }, NOW));
});

test("due window includes recent reminders once and ignores future or stale ones", () => {
  const due = item({ fireAt: NOW - 1_000 });
  const future = item({ id: "later", fireAt: NOW + 60_000 });
  const stale = item({ id: "old", fireAt: NOW - DUE_WINDOW_MS });
  const sent = item({ id: "sent", sentAt: NOW - 10 });
  const found = dueReminders([due, future, stale, sent], NOW);
  assert.deepEqual(found.map((reminder) => reminder.id), ["evt1"]);
});

test("merge keeps a sent flag so a second sync cannot fire the same reminder", () => {
  const incoming = [item({})];
  const first = mergeReminders([], incoming, NOW);
  assert.equal(first[0].sentAt, undefined);
  const marked = markSent(first, [first[0].key], NOW);
  const second = mergeReminders(marked, incoming, NOW);
  assert.equal(second[0].sentAt, NOW);
  assert.equal(dueReminders(second, NOW).length, 0);
});

test("editing the start time is a new key and can fire", () => {
  const original = markSent([item({})], [reminderKey(item({}))], NOW);
  const edited = item({ start: "11:00", fireAt: NOW - 5_000 });
  const merged = mergeReminders(original, [edited], NOW);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, reminderKey(edited));
  assert.equal(merged[0].sentAt, undefined);
  assert.equal(dueReminders(merged, NOW).length, 1);
});

test("a deleted event is removed and a late one is skipped instead of sent", () => {
  const kept = item({ id: "keep", fireAt: NOW + 60_000 });
  const late = item({ id: "late", fireAt: NOW - DUE_WINDOW_MS - 1 });
  const merged = mergeReminders(
    [item({ id: "gone", sentAt: NOW })],
    normalizeReminders([kept, late], NOW),
    NOW,
  );
  assert.deepEqual(merged.map((reminder) => reminder.id), ["keep", "late"]);
  assert.ok(merged[1].skippedAt);
  assert.equal(dueReminders(merged, NOW).length, 0);
});

test("markSent then unmarkSent lets a failed send retry once", () => {
  const reminders = [item({})];
  const marked = markSent(reminders, [reminders[0].key], NOW);
  assert.equal(dueReminders(marked, NOW).length, 0);
  const unmarked = unmarkSent(marked, [reminders[0].key]);
  assert.equal(dueReminders(unmarked, NOW).length, 1);
});

test("prune drops sent reminders older than the retention window", () => {
  const oldSent = item({ fireAt: NOW - 49 * 60 * 60 * 1000, sentAt: NOW - 49 * 60 * 60 * 1000 });
  const freshSent = item({ id: "fresh", fireAt: NOW - 60_000, sentAt: NOW });
  const pruned = pruneReminders([oldSent, freshSent], NOW);
  assert.deepEqual(pruned.map((reminder) => reminder.id), ["fresh"]);
});

test("expired push subscriptions are only 404 and 410", () => {
  assert.equal(isExpiredSubscription(404), true);
  assert.equal(isExpiredSubscription(410), true);
  assert.equal(isExpiredSubscription(201), false);
  assert.equal(isExpiredSubscription(500), false);
  assert.equal(isExpiredSubscription(0), false);
});
