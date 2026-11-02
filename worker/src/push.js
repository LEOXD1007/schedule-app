import { buildPushPayload } from "@block65/webcrypto-web-push";

/**
 * Encrypt and POST one Web Push message (RFC 8291 aes128gcm + RFC 8292 VAPID).
 * Returns the push service HTTP status. Throws if VAPID is not configured.
 */
export async function sendWebPush(subscription, data, env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    throw new Error("vapid_not_configured");
  }
  const payload = await buildPushPayload(
    {
      data: JSON.stringify(data),
      options: { ttl: 900 },
    },
    {
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime ?? null,
      keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
    },
    {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    },
  );
  const headers = new Headers(payload.headers || undefined);
  if (!headers.has("Urgency")) headers.set("Urgency", "high");
  const response = await fetch(subscription.endpoint, { ...payload, headers });
  return response.status;
}
