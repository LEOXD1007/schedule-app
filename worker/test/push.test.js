import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import test from "node:test";
import { sendWebPush } from "../src/push.js";

function vapidPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateJwk = privateKey.export({ format: "jwk" });
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(publicJwk.x, "base64url"),
    Buffer.from(publicJwk.y, "base64url"),
  ]);
  return {
    publicKey: point.toString("base64url"),
    privateKey: Buffer.from(privateJwk.d, "base64url").toString("base64url"),
  };
}

function subscriber() {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  return {
    endpoint: "https://web.push.apple.com/fake",
    expirationTime: null,
    keys: {
      p256dh: point.toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
}

test("sendWebPush builds an aes128gcm request and returns the push service status", async () => {
  const vapid = vapidPair();
  const subscription = subscriber();
  const original = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(null, { status: 201 });
  };
  try {
    const status = await sendWebPush(
      subscription,
      { title: "项目周会", body: "09:00 – 10:00", tag: "evt1", url: "./index.html" },
      {
        VAPID_PUBLIC_KEY: vapid.publicKey,
        VAPID_PRIVATE_KEY: vapid.privateKey,
        VAPID_SUBJECT: "mailto:you@example.com",
      },
    );
    assert.equal(status, 201);
    assert.equal(String(captured.url), subscription.endpoint);
    const headers = new Headers(captured.init.headers);
    assert.match(headers.get("authorization") || headers.get("Authorization") || "", /^vapid /i);
    assert.equal(
      (headers.get("content-encoding") || headers.get("Content-Encoding") || "").toLowerCase(),
      "aes128gcm",
    );
    assert.equal(headers.get("TTL") || headers.get("ttl"), "900");
    assert.ok(captured.init.body);
  } finally {
    globalThis.fetch = original;
  }
});

test("sendWebPush refuses to run without VAPID keys", async () => {
  await assert.rejects(
    () => sendWebPush(subscriber(), { title: "x" }, {}),
    /vapid_not_configured/,
  );
});
