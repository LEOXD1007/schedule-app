import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest, runCron } from "../src/http.js";
import { subscriptionId } from "../src/schedule.js";

const ENDPOINT = "https://web.push.apple.com/test-device";
const SUBSCRIPTION = {
  endpoint: ENDPOINT,
  expirationTime: null,
  keys: { p256dh: "B".repeat(80), auth: "a".repeat(22) },
};

function memoryKV() {
  const store = new Map();
  return {
    async get(key, type) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "", cursor } = {}) {
      const names = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = names.slice(start);
      return { keys: slice.map((name) => ({ name })), list_complete: true, cursor: undefined };
    },
    dump() {
      return store;
    },
  };
}

function envWith(kv, extra = {}) {
  return { REMINDERS: kv, APP_TOKEN: "", ...extra };
}

function call(env, method, path, body, headers = {}) {
  return handleRequest(
    new Request(`https://push.example${path}`, {
      method,
      headers: { Origin: "https://leoxd1007.github.io", "Content-Type": "application/json", ...headers },
      body: body == null ? undefined : JSON.stringify(body),
    }),
    env,
  );
}

async function stored(kv) {
  const id = await subscriptionId(ENDPOINT);
  return kv.get(`sub:${id}`, "json");
}

test("CORS reflects the Pages origin and answers preflight", async () => {
  const response = await handleRequest(
    new Request("https://push.example/api/health", {
      method: "OPTIONS",
      headers: { Origin: "https://leoxd1007.github.io", "Access-Control-Request-Method": "POST" },
    }),
    envWith(memoryKV()),
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://leoxd1007.github.io");
});

test("CORS does not reflect an unrelated origin", async () => {
  const response = await handleRequest(
    new Request("https://push.example/api/health", { headers: { Origin: "https://evil.example" } }),
    envWith(memoryKV()),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://leoxd1007.github.io");
});

test("localhost is allowed and health does not require the app token", async () => {
  const response = await handleRequest(
    new Request("https://push.example/api/health", { headers: { Origin: "http://127.0.0.1:8787" } }),
    envWith(memoryKV(), { APP_TOKEN: "secret" }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:8787");
});

test("APP_TOKEN rejects subscribe and accepts the matching bearer", async () => {
  const kv = memoryKV();
  const env = envWith(kv, { APP_TOKEN: "secret" });
  const denied = await call(env, "POST", "/api/subscribe", { subscription: SUBSCRIPTION });
  assert.equal(denied.status, 401);
  const allowed = await call(env, "POST", "/api/subscribe", { subscription: SUBSCRIPTION }, {
    Authorization: "Bearer secret",
  });
  assert.equal(allowed.status, 200);
  assert.ok(await stored(kv));
});

test("subscribe, sync, and unsubscribe round-trip one device", async () => {
  const kv = memoryKV();
  const env = envWith(kv);
  assert.equal((await call(env, "POST", "/api/subscribe", { subscription: SUBSCRIPTION })).status, 200);
  const now = Date.now();
  const synced = await call(env, "POST", "/api/sync", {
    subscription: SUBSCRIPTION,
    reminders: [
      {
        id: "evt1",
        title: "项目周会",
        body: "09:00",
        date: "2026-11-02",
        allDay: false,
        start: "09:00",
        reminder: 10,
        fireAt: now + 60_000,
      },
    ],
  });
  assert.equal(synced.status, 200);
  assert.equal((await synced.json()).stored, 1);
  assert.equal((await call(env, "DELETE", "/api/subscribe", { endpoint: ENDPOINT })).status, 200);
  assert.equal(await stored(kv), null);
});

test("cron sends a due reminder once, then a resync does not send it again", async () => {
  const kv = memoryKV();
  const env = envWith(kv);
  const now = Date.now();
  const reminder = {
    id: "evt1",
    title: "项目周会",
    body: "09:00 – 10:00",
    date: "2026-11-02",
    allDay: false,
    start: "09:00",
    reminder: 10,
    fireAt: now - 30_000,
  };
  await call(env, "POST", "/api/sync", { subscription: SUBSCRIPTION, reminders: [reminder] });

  const sent = [];
  const send = async (_subscription, data) => {
    sent.push(data.tag);
    return 201;
  };
  const first = await runCron(env, send, now);
  assert.equal(first.sent, 1);
  assert.deepEqual(sent, ["evt1@2026-11-0209:00#10"]);

  const second = await runCron(env, send, now + 60_000);
  assert.equal(second.sent, 0);
  assert.equal(sent.length, 1);

  await call(env, "POST", "/api/sync", { subscription: SUBSCRIPTION, reminders: [reminder] });
  const third = await runCron(env, send, now + 120_000);
  assert.equal(third.sent, 0);
  assert.equal(sent.length, 1);
  assert.equal((await stored(kv)).reminders[0].sentAt, now);
});

test("a 500 leaves the reminder unmarked and the next cron retries", async () => {
  const kv = memoryKV();
  const env = envWith(kv);
  const now = Date.now();
  await call(env, "POST", "/api/sync", {
    subscription: SUBSCRIPTION,
    reminders: [
      {
        id: "evt1",
        title: "项目周会",
        body: "09:00",
        date: "2026-11-02",
        allDay: false,
        start: "09:00",
        reminder: 0,
        fireAt: now - 1_000,
      },
    ],
  });
  let attempts = 0;
  const send = async () => {
    attempts += 1;
    return attempts === 1 ? 500 : 201;
  };
  const first = await runCron(env, send, now);
  assert.equal(first.failed, 1);
  assert.equal(first.sent, 0);
  const second = await runCron(env, send, now + 1_000);
  assert.equal(second.sent, 1);
  assert.equal(attempts, 2);
});

test("404 and 410 delete the subscription", async () => {
  for (const status of [404, 410]) {
    const kv = memoryKV();
    const env = envWith(kv);
    const now = Date.now();
    await call(env, "POST", "/api/sync", {
      subscription: SUBSCRIPTION,
      reminders: [
        {
          id: "evt1",
          title: "项目周会",
          body: "09:00",
          date: "2026-11-02",
          allDay: false,
          start: "09:00",
          reminder: 0,
          fireAt: now - 1_000,
        },
      ],
    });
    const result = await runCron(env, async () => status, now);
    assert.equal(result.removed, 1);
    assert.equal(await stored(kv), null);
  }
});
