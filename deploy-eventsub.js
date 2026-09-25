import "dotenv/config";
import {
  ensureSubscriptions,
  getAppAccessToken,
  listSubscriptions,
  readEventSubConfig
} from "./src/services/eventSubManager.js";
import { loadConfig } from "./src/configStore.js";

/**
 * Manage EventSub webhook subscriptions.
 *
 *   npm run deploy-eventsub            create missing subscriptions, remove revoked/stale ones
 *   npm run deploy-eventsub -- --list  show every subscription registered for this client id
 *   npm run deploy-eventsub -- --dry-run  report what would change without changing anything
 *
 * The running bot performs the same reconciliation at startup and on a timer
 * (see EVENTSUB_RECONCILE_MINUTES), so this script is mainly for a first-time
 * setup or for inspecting state from the command line.
 */

const args = new Set(process.argv.slice(2));
const config = readEventSubConfig({ ...process.env, EVENTSUB_ENABLED: "true" });

if (config.missing.length > 0) {
  throw new Error(`Missing ${config.missing.join(", ")}`);
}

async function list() {
  const accessToken = await getAppAccessToken(config.clientId, config.clientSecret);
  const subscriptions = await listSubscriptions(config.clientId, accessToken);

  if (subscriptions.length === 0) {
    console.log("No EventSub subscriptions registered for this client id");
    return;
  }

  console.log(`Callback expected by this deployment: ${config.callbackUrl}\n`);
  for (const sub of subscriptions) {
    const callback = sub.transport?.callback || "(no callback)";
    const marker = callback === config.callbackUrl ? "" : "  <- different callback";
    console.log(`${sub.status.padEnd(32)} ${sub.type.padEnd(17)} ${JSON.stringify(sub.condition)}`);
    console.log(`${"".padEnd(32)} id=${sub.id}`);
    console.log(`${"".padEnd(32)} ${callback}${marker}`);
  }
}

async function main() {
  if (args.has("--list")) {
    await list();
    return;
  }

  // Same channel.moderate set the bot keeps (ban sync source channel), so running this script
  // does not remove what the bot created
  const banSync = (await loadConfig())?.banSync || {};
  const moderation = {
    moderator: config.moderatorLogin,
    channels: banSync.enabled && banSync.sourceChannel ? [banSync.sourceChannel] : []
  };

  const summary = await ensureSubscriptions({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    callbackUrl: config.callbackUrl,
    secret: config.secret,
    broadcasters: config.broadcasters,
    moderation,
    dryRun: args.has("--dry-run"),
    logger: console
  });

  console.log(
    `\nDone: created ${summary.created}, removed ${summary.removed}, kept ${summary.kept}`
  );
}

main().catch((error) => {
  console.error("EventSub deploy failed", error);
  process.exit(1);
});
