#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicJwk = publicKey.export({ format: "jwk" });
const privateJwk = privateKey.export({ format: "jwk" });
const x = Buffer.from(publicJwk.x, "base64url");
const y = Buffer.from(publicJwk.y, "base64url");
const uncompressed = Buffer.concat([Buffer.from([0x04]), x, y]);

const vapidPublic = uncompressed.toString("base64url");
const vapidPrivate = Buffer.from(privateJwk.d, "base64url").toString("base64url");

console.log("VAPID 密钥已生成。私钥不要提交到 git。\n");
console.log(`VAPID_PUBLIC_KEY=${vapidPublic}`);
console.log(`VAPID_PRIVATE_KEY=${vapidPrivate}`);
console.log("\n公钥：写入 worker/wrangler.toml 的 VAPID_PUBLIC_KEY，以及 index.html 里的 PUSH_CONFIG.vapidPublicKey。");
console.log("私钥：在 worker 目录执行 npx wrangler secret put VAPID_PRIVATE_KEY ，然后粘贴上面的私钥。");
