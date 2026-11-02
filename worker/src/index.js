import { handleRequest, runCron } from "./http.js";
import { sendWebPush } from "./push.js";

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runCron(env, (subscription, data) => sendWebPush(subscription, data, env)).then((stats) => {
        console.log(JSON.stringify({ cron: stats }));
      }),
    );
  },
};
