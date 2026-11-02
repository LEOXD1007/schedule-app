import {
  MAX_SEND_PER_RUN,
  dueReminders,
  isExpiredSubscription,
  markSent,
  mergeReminders,
  normalizeReminders,
  normalizeSubscription,
  pruneReminders,
  subscriptionId,
  unmarkSent,
} from "./schedule.js";

const PAGE_ORIGIN = "https://leoxd1007.github.io";

export function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const allow = origin === PAGE_ORIGIN || local ? origin : PAGE_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request),
    },
  });
}

function authorized(request, env) {
  if (!env.APP_TOKEN) return true;
  return request.headers.get("Authorization") === `Bearer ${env.APP_TOKEN}`;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(request, 200, {
      ok: true,
      vapid: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT),
    });
  }

  const routed =
    (request.method === "POST" && url.pathname === "/api/subscribe") ||
    (request.method === "DELETE" && url.pathname === "/api/subscribe") ||
    (request.method === "POST" && url.pathname === "/api/sync");
  if (!routed) return json(request, 404, { error: "not_found" });
  if (!authorized(request, env)) return json(request, 401, { error: "unauthorized" });

  if (request.method === "POST" && url.pathname === "/api/subscribe") {
    return subscribe(request, env);
  }
  if (request.method === "DELETE" && url.pathname === "/api/subscribe") {
    return unsubscribe(request, env);
  }
  return sync(request, env);
}

async function subscribe(request, env) {
  const body = await readJson(request);
  const subscription = normalizeSubscription(body && body.subscription);
  if (!subscription) return json(request, 400, { error: "bad_subscription" });
  const id = await subscriptionId(subscription.endpoint);
  const key = `sub:${id}`;
  const existing = await env.REMINDERS.get(key, "json");
  await env.REMINDERS.put(
    key,
    JSON.stringify({
      subscription,
      reminders: existing && Array.isArray(existing.reminders) ? existing.reminders : [],
      updatedAt: Date.now(),
    }),
  );
  return json(request, 200, { ok: true, id });
}

async function unsubscribe(request, env) {
  const body = await readJson(request);
  const endpoint = body && (body.endpoint || (body.subscription && body.subscription.endpoint));
  if (typeof endpoint !== "string" || !endpoint) return json(request, 400, { error: "bad_endpoint" });
  const id = await subscriptionId(endpoint);
  await env.REMINDERS.delete(`sub:${id}`);
  return json(request, 200, { ok: true });
}

async function sync(request, env) {
  const body = await readJson(request);
  const subscription = normalizeSubscription(body && body.subscription);
  if (!subscription) return json(request, 400, { error: "bad_subscription" });
  const now = Date.now();
  const incoming = normalizeReminders(body && body.reminders, now);
  if (!incoming) return json(request, 400, { error: "bad_reminders" });
  const id = await subscriptionId(subscription.endpoint);
  const key = `sub:${id}`;
  const existing = await env.REMINDERS.get(key, "json");
  const reminders = pruneReminders(mergeReminders(existing && existing.reminders, incoming, now), now);
  await env.REMINDERS.put(
    key,
    JSON.stringify({ subscription, reminders, updatedAt: now }),
  );
  return json(request, 200, { ok: true, id, stored: reminders.length });
}

/**
 * Send reminders that are due, then mark them sent.
 * Retryable failures are unmarked so the next minute can try again.
 * 404 and 410 drop the subscription.
 */
export async function runCron(env, send, now = Date.now()) {
  const stats = { checked: 0, sent: 0, failed: 0, removed: 0 };
  if (!env.REMINDERS) return stats;
  let cursor;
  do {
    const page = await env.REMINDERS.list({ prefix: "sub:", cursor });
    for (const item of page.keys) {
      const record = await env.REMINDERS.get(item.name, "json");
      if (!record || !record.subscription) continue;
      stats.checked += 1;
      const outcome = await dispatchRecord(env, item.name, record, send, now);
      stats.sent += outcome.sent;
      stats.failed += outcome.failed;
      stats.removed += outcome.removed;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return stats;
}

async function dispatchRecord(env, name, record, send, now) {
  const reminders = Array.isArray(record.reminders) ? record.reminders : [];
  const due = dueReminders(reminders, now).slice(0, MAX_SEND_PER_RUN);
  if (!due.length) {
    const pruned = pruneReminders(reminders, now);
    if (pruned.length !== reminders.length) {
      await env.REMINDERS.put(name, JSON.stringify({ ...record, reminders: pruned }));
    }
    return { sent: 0, failed: 0, removed: 0 };
  }

  const claimed = markSent(reminders, due.map((reminder) => reminder.key), now);
  await env.REMINDERS.put(name, JSON.stringify({ ...record, reminders: claimed, updatedAt: now }));

  const retry = [];
  let sent = 0;
  let failed = 0;
  for (const reminder of due) {
    let status = 0;
    try {
      status = await send(record.subscription, {
        title: reminder.title,
        body: reminder.body,
        tag: reminder.key,
        url: "./index.html",
      });
    } catch {
      status = 0;
    }
    if (isExpiredSubscription(status)) {
      await env.REMINDERS.delete(name);
      return { sent, failed, removed: 1 };
    }
    if (status >= 200 && status < 300) {
      sent += 1;
    } else {
      retry.push(reminder.key);
      failed += 1;
    }
  }

  if (retry.length) {
    const latest = (await env.REMINDERS.get(name, "json")) || record;
    latest.reminders = unmarkSent(latest.reminders, retry);
    await env.REMINDERS.put(name, JSON.stringify(latest));
  }
  return { sent, failed, removed: 0 };
}
