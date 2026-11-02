/** Pure reminder scheduling. No Worker or network dependencies. */

export const DUE_WINDOW_MS = 15 * 60 * 1000;
export const MAX_REMINDERS = 500;
export const MAX_SEND_PER_RUN = 20;
export const PRUNE_AGE_MS = 48 * 60 * 60 * 1000;

const REMINDER_MINUTES = new Set([0, 10, 30, 60]);

/**
 * Stable identity for one firing of an event.
 * id + "@" + date + (allDay ? "" : start) + "#" + reminder
 * Editing the date, start, or lead time produces a new key so it can fire again.
 */
export function reminderKey(reminder) {
  const start = reminder.allDay ? "" : String(reminder.start || "");
  return `${reminder.id}@${reminder.date}${start}#${reminder.reminder}`;
}

export function normalizeSubscription(input) {
  if (!input || typeof input.endpoint !== "string") return null;
  if (!/^https:\/\//.test(input.endpoint) || input.endpoint.length > 2000) return null;
  const keys = input.keys || {};
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return null;
  if (!keys.p256dh || !keys.auth || keys.p256dh.length > 200 || keys.auth.length > 100) return null;
  return {
    endpoint: input.endpoint,
    expirationTime: typeof input.expirationTime === "number" ? input.expirationTime : null,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

export function normalizeReminder(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "");
  const title = String(raw.title || "").trim();
  const date = String(raw.date || "");
  if (!id || id.length > 80 || !title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const reminder = Number(raw.reminder);
  if (!REMINDER_MINUTES.has(reminder)) return null;
  const allDay = Boolean(raw.allDay);
  const start = allDay ? "" : String(raw.start || "");
  if (!allDay && !/^\d{2}:\d{2}$/.test(start)) return null;
  const fireAt = Number(raw.fireAt);
  if (!Number.isFinite(fireAt)) return null;
  if (fireAt < now - 24 * 60 * 60 * 1000) return null;
  if (fireAt > now + 2 * 366 * 24 * 60 * 60 * 1000) return null;
  return {
    id,
    title: title.slice(0, 100),
    body: String(raw.body || "").slice(0, 180),
    date,
    allDay,
    start,
    reminder,
    fireAt,
    key: reminderKey({ id, date, allDay, start, reminder }),
  };
}

export function normalizeReminders(list, now) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const item = normalizeReminder(raw, now);
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
    if (out.length >= MAX_REMINDERS) break;
  }
  return out;
}

/**
 * Replace the stored schedule with `incoming`.
 * A key that already fired stays marked sent so a later sync cannot send it twice.
 * Reminders already older than the delivery window are kept as skipped, not due.
 */
export function mergeReminders(existing, incoming, now, windowMs = DUE_WINDOW_MS) {
  const prevByKey = new Map();
  for (const reminder of existing || []) {
    if (reminder && reminder.key) prevByKey.set(reminder.key, reminder);
  }
  const next = [];
  for (const incomingReminder of incoming) {
    const prev = prevByKey.get(incomingReminder.key);
    if (prev && prev.sentAt) {
      next.push({ ...incomingReminder, sentAt: prev.sentAt });
      continue;
    }
    if (incomingReminder.fireAt <= now - windowMs) {
      next.push({ ...incomingReminder, skippedAt: (prev && prev.skippedAt) || now });
      continue;
    }
    next.push({ ...incomingReminder });
  }
  return next;
}

export function dueReminders(reminders, now, windowMs = DUE_WINDOW_MS) {
  return (reminders || []).filter((reminder) => {
    if (!reminder || reminder.sentAt || reminder.skippedAt) return false;
    if (typeof reminder.fireAt !== "number") return false;
    return reminder.fireAt <= now && now - reminder.fireAt < windowMs;
  });
}

export function markSent(reminders, keys, sentAt) {
  const selected = new Set(keys);
  return (reminders || []).map((reminder) => {
    if (!selected.has(reminder.key)) return reminder;
    return { ...reminder, sentAt };
  });
}

export function unmarkSent(reminders, keys) {
  const selected = new Set(keys);
  return (reminders || []).map((reminder) => {
    if (!selected.has(reminder.key)) return reminder;
    const copy = { ...reminder };
    delete copy.sentAt;
    return copy;
  });
}

export function pruneReminders(reminders, now, ageMs = PRUNE_AGE_MS) {
  return (reminders || []).filter((reminder) => {
    if (!reminder || typeof reminder.fireAt !== "number") return false;
    if ((reminder.sentAt || reminder.skippedAt) && now - reminder.fireAt > ageMs) return false;
    return true;
  });
}

export function isExpiredSubscription(status) {
  return status === 404 || status === 410;
}

export async function subscriptionId(endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
