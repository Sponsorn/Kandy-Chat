import crypto from "node:crypto";
import { join } from "node:path";
import { parseBool } from "../envUtils.js";
import { sessionMiddleware, startSessionCleanup, destroySession, createLogoutCookie, Permissions } from "../auth/sessionManager.js";
import { createDiscordAuthRoutes } from "../auth/discordOAuth.js";
import { createTwitchAuthRoutes } from "../auth/twitchOAuth.js";
import { createMonitoringRoutes } from "./routes/monitoringRoutes.js";
import { createConfigRoutes } from "./routes/configRoutes.js";
import { createControlRoutes } from "./routes/controlRoutes.js";
import { createDashboardSocket } from "./websocket/dashboardSocket.js";

/**
 * Verify EventSub webhook signature
 */
function verifySignature(secret, messageId, timestamp, rawBody, signature) {
  if (!secret || !signature || !messageId || !timestamp) return false;
  const message = `${messageId}${timestamp}${rawBody}`;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(message).digest("hex")}`;
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

function getHeader(req, name) {
  return req.headers[name.toLowerCase()] ?? "";
}

async function loadExpress() {
  const mod = await import("express");
  return mod.default;
}

/**
 * Start the combined web server
 * Handles EventSub webhooks, dashboard API, and static files
 */
export async function startWebServer(env, options = {}) {
  const {
    logger,
    onEvent,
    twitchAPIClient,
    updateBlacklistFromEntries
  } = options;

  const dashboardEnabled = parseBool(env.DASHBOARD_ENABLED, false);
  const eventsubEnabled = parseBool(env.EVENTSUB_ENABLED, false);

  // If neither dashboard nor eventsub is enabled, skip server creation
  if (!dashboardEnabled && !eventsubEnabled) {
    logger?.log("Web server disabled (neither DASHBOARD_ENABLED nor EVENTSUB_ENABLED)");
    return null;
  }

  const port = Number.parseInt(env.EVENTSUB_PORT || env.DASHBOARD_PORT, 10) || 8080;
  const eventsubPath = env.EVENTSUB_CALLBACK_PATH || "/eventsub";
  const eventsubSecret = env.EVENTSUB_SECRET;

  const express = await loadExpress();
  const app = express();

  // Trust proxy for correct IP behind reverse proxy
  app.set("trust proxy", 1);

  // Body parsing with raw body capture for EventSub signature verification
  app.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    }
  }));

  // Session middleware for dashboard
  if (dashboardEnabled) {
    app.use(sessionMiddleware());
    startSessionCleanup();
  }

  // CSRF protection for state-changing endpoints
  const csrfProtection = (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      return next();
    }

    // Check origin header matches
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && host) {
      try {
        const originUrl = new URL(origin);
        if (originUrl.host !== host) {
          return res.status(403).json({ error: "CSRF validation failed" });
        }
      } catch {
        return res.status(403).json({ error: "Invalid origin header" });
      }
    }

    next();
  };

  // Rate limiting for API endpoints
  const rateLimits = new Map();
  const rateLimit = (maxRequests = 60, windowMs = 60000) => {
    return (req, res, next) => {
      const key = req.ip || req.connection.remoteAddress;
      const now = Date.now();
      const windowStart = now - windowMs;

      let record = rateLimits.get(key);
      if (!record || record.windowStart < windowStart) {
        record = { windowStart: now, count: 0 };
        rateLimits.set(key, record);
      }

      record.count++;
      if (record.count > maxRequests) {
        return res.status(429).json({ error: "Too many requests" });
      }

      next();
    };
  };

  // EventSub webhook endpoint
  if (eventsubEnabled && eventsubSecret) {
    app.post(eventsubPath, (req, res) => {
      const messageId = getHeader(req, "Twitch-Eventsub-Message-Id");
      const timestamp = getHeader(req, "Twitch-Eventsub-Message-Timestamp");
      const signature = getHeader(req, "Twitch-Eventsub-Message-Signature");

      if (!verifySignature(eventsubSecret, messageId, timestamp, req.rawBody || "", signature)) {
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
    logger?.log(`EventSub webhook endpoint: ${eventsubPath}`);
  }

  // Dashboard routes
  if (dashboardEnabled) {
    // Apply CSRF and rate limiting to API routes
    app.use("/api", csrfProtection, rateLimit(100, 60000));
    app.use("/auth", rateLimit(20, 60000));

    // Auth routes
    const dashboardDomain = env.DASHBOARD_DOMAIN || null;
    const cookieSecure = env.NODE_ENV !== "development";

    // Discord OAuth
    if (env.DISCORD_CLIENT_ID && env.DASHBOARD_DISCORD_CLIENT_SECRET) {
      createDiscordAuthRoutes(app, {
        clientId: env.DISCORD_CLIENT_ID,
        clientSecret: env.DASHBOARD_DISCORD_CLIENT_SECRET,
        redirectUri: `https://${dashboardDomain}/auth/discord/callback`,
        guildId: env.DISCORD_GUILD_ID,
        adminRoleIds: env.ADMIN_ROLE_ID,
        modRoleIds: env.MOD_ROLE_ID,
        dashboardDomain,
        cookieSecure
      });
      logger?.log("Discord OAuth enabled");
    }

    // Twitch OAuth
    if (env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET) {
      createTwitchAuthRoutes(app, {
        clientId: env.TWITCH_CLIENT_ID,
        clientSecret: env.TWITCH_CLIENT_SECRET,
        redirectUri: `https://${dashboardDomain}/auth/twitch/callback`,
        configuredChannels: env.TWITCH_CHANNEL?.split(",").map(c => c.trim().toLowerCase()) || [],
        dashboardDomain,
        cookieSecure
      });
      logger?.log("Twitch OAuth enabled");
    }

    // Auth info and logout
    app.get("/auth/me", (req, res) => {
      if (!req.session) {
        return res.json({ authenticated: false });
      }

      res.json({
        authenticated: true,
        user: {
          provider: req.session.user.provider,
          username: req.session.user.username || req.session.user.displayName,
          avatar: req.session.user.avatar
        },
        permission: req.session.permission,
        permissionName: Object.keys(Permissions).find(k => Permissions[k] === req.session.permission) || "unknown"
      });
    });

    app.post("/auth/logout", (req, res) => {
      if (req.sessionId) {
        destroySession(req.sessionId);
      }
      res.setHeader("Set-Cookie", createLogoutCookie());
      res.json({ success: true });
    });

    // API routes
    app.use(createMonitoringRoutes());
    app.use(createConfigRoutes({ updateBlacklistFromEntries }));
    app.use(createControlRoutes({ twitchAPIClient }));

    // Static files for dashboard frontend
    const publicPath = join(process.cwd(), "public");
    app.use(express.static(publicPath));

    // SPA fallback - serve index.html for non-API routes
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/auth") || req.path === eventsubPath) {
        return next();
      }
      res.sendFile(join(publicPath, "index.html"));
    });

    logger?.log("Dashboard routes enabled");
  }

  // Error handling
  app.use((err, req, res, next) => {
    console.error("Server error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  // Start HTTP server
  const server = app.listen(port, () => {
    logger?.log(`Web server listening on port ${port}`);
  });

  // Attach WebSocket server for real-time updates
  if (dashboardEnabled) {
    createDashboardSocket(server);
    logger?.log("WebSocket server enabled on /ws");
  }

  return server;
}

// Re-export for backwards compatibility
export { startWebServer as startEventSubServer };
