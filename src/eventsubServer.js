import crypto from "node:crypto";

function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function verifySignature(secret, messageId, timestamp, rawBody, signature) {
  if (!secret || !signature || !messageId || !timestamp) return false;
  const message = `${messageId}${timestamp}${rawBody}`;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(message).digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function getHeader(req, name) {
  return req.headers[name.toLowerCase()] ?? "";
}

async function loadExpress() {
  const mod = await import("express");
  return mod.default;
}

export async function startEventSubServer(env, { logger, onEvent } = {}) {
  const enabled = parseBool(env.EVENTSUB_ENABLED, false);
  if (!enabled) return null;

  const secret = env.EVENTSUB_SECRET;
  const port = Number.parseInt(env.EVENTSUB_PORT, 10) || 8080;
  const path = env.EVENTSUB_CALLBACK_PATH || "/eventsub";

  if (!secret) {
    logger?.warn("EventSub disabled: EVENTSUB_SECRET not set");
    return null;
  }

  const express = await loadExpress();
  const app = express();
  app.use(
    express.json({
      verify: (req, res, buf) => {
        req.rawBody = buf.toString("utf8");
      }
    })
  );

  app.post(path, (req, res) => {
    const messageId = getHeader(req, "Twitch-Eventsub-Message-Id");
    const timestamp = getHeader(req, "Twitch-Eventsub-Message-Timestamp");
    const signature = getHeader(req, "Twitch-Eventsub-Message-Signature");

    if (!verifySignature(secret, messageId, timestamp, req.rawBody || "", signature)) {
      logger?.warn("EventSub: signature verification failed");
      res.sendStatus(403);
      return;
    }

    const messageType = getHeader(req, "Twitch-Eventsub-Message-Type");
    if (messageType === "webhook_callback_verification") {
      res.status(200).send(req.body?.challenge ?? "");
      return;
    }

    if (messageType === "notification") {
      onEvent?.(req.body);
      res.sendStatus(204);
      return;
    }

    res.sendStatus(204);
  });

  const server = app.listen(port, () => {
    logger?.log(`EventSub server listening on port ${port}${path}`);
  });

  return server;
}
