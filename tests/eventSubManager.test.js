import { describe, it, expect, vi } from "vitest";
import {
  buildCallbackUrl,
  buildRequiredSubscriptions,
  planReconciliation,
  readEventSubConfig,
  ensureSubscriptions
} from "../src/services/eventSubManager.js";

const CALLBACK = "https://example.com/eventsub";

function sub(overrides) {
  return {
    id: overrides.id || Math.random().toString(36).slice(2),
    status: "enabled",
    type: "stream.online",
    condition: { broadcaster_user_id: "123" },
    transport: { method: "webhook", callback: CALLBACK },
    ...overrides
  };
}

describe("buildCallbackUrl", () => {
  it("joins public url and path, tolerating trailing slash and missing leading slash", () => {
    expect(buildCallbackUrl("https://example.com/", "/eventsub")).toBe(CALLBACK);
    expect(buildCallbackUrl("https://example.com", "eventsub")).toBe(CALLBACK);
    expect(buildCallbackUrl(" https://example.com ", undefined)).toBe(CALLBACK);
  });
});

describe("buildRequiredSubscriptions", () => {
  it("creates online, offline and raid subscriptions per broadcaster", () => {
    const required = buildRequiredSubscriptions(new Map([["kandyland", "123"]]));
    expect(required).toEqual([
      {
        login: "kandyland",
        type: "stream.online",
        version: "1",
        condition: { broadcaster_user_id: "123" }
      },
      {
        login: "kandyland",
        type: "stream.offline",
        version: "1",
        condition: { broadcaster_user_id: "123" }
      },
      {
        login: "kandyland",
        type: "channel.raid",
        version: "1",
        condition: { from_broadcaster_user_id: "123" }
      }
    ]);
  });
});

describe("planReconciliation", () => {
  const required = buildRequiredSubscriptions(new Map([["kandyland", "123"]]));

  it("keeps a healthy set and changes nothing", () => {
    const existing = [
      sub({ type: "stream.online" }),
      sub({ type: "stream.offline" }),
      sub({ type: "channel.raid", condition: { from_broadcaster_user_id: "123" } })
    ];
    const plan = planReconciliation(existing, required, CALLBACK);
    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toHaveLength(3);
  });

  it("creates everything when nothing is registered", () => {
    const plan = planReconciliation([], required, CALLBACK);
    expect(plan.create.map((c) => c.type)).toEqual([
      "stream.online",
      "stream.offline",
      "channel.raid"
    ]);
    expect(plan.remove).toEqual([]);
  });

  it("removes revoked subscriptions and recreates them", () => {
    const revoked = sub({ id: "dead", status: "notification_failures_exceeded" });
    const plan = planReconciliation(
      [
        revoked,
        sub({ type: "stream.offline" }),
        sub({ type: "channel.raid", condition: { from_broadcaster_user_id: "123" } })
      ],
      required,
      CALLBACK
    );
    expect(plan.remove).toEqual([revoked]);
    expect(plan.create.map((c) => c.type)).toEqual(["stream.online"]);
  });

  it("creates our subscriptions even when an old callback still has enabled ones", () => {
    // After EVENTSUB_PUBLIC_URL changes, the old ones stay until Twitch revokes them
    const stale = sub({
      id: "old",
      transport: { method: "webhook", callback: "https://old.example.com/eventsub" }
    });
    const plan = planReconciliation([stale], required, CALLBACK);
    expect(plan.remove).toEqual([]);
    expect(plan.create).toHaveLength(3);
  });

  it("removes revoked subscriptions on an old callback", () => {
    const stale = sub({
      id: "old",
      status: "notification_failures_exceeded",
      transport: { method: "webhook", callback: "https://old.example.com/eventsub" }
    });
    const plan = planReconciliation([stale], required, CALLBACK);
    expect(plan.remove).toEqual([stale]);
  });

  it("removes duplicates but keeps one", () => {
    const a = sub({ id: "a" });
    const b = sub({ id: "b" });
    const plan = planReconciliation([a, b], required, CALLBACK);
    expect(plan.keep).toContain(a);
    expect(plan.remove).toEqual([b]);
  });

  it("removes enabled subscriptions on our callback that are no longer required", () => {
    const other = sub({ id: "other", condition: { broadcaster_user_id: "999" } });
    const plan = planReconciliation([other], required, CALLBACK);
    expect(plan.remove).toEqual([other]);
  });

  it("leaves enabled subscriptions for a different callback alone", () => {
    const elsewhere = sub({
      id: "elsewhere",
      status: "enabled",
      transport: { method: "webhook", callback: "https://staging.example.com/eventsub" }
    });
    const plan = planReconciliation([elsewhere], required, CALLBACK);
    expect(plan.remove).not.toContain(elsewhere);
    expect(plan.keep).toContain(elsewhere);
  });
});

describe("readEventSubConfig", () => {
  const base = {
    EVENTSUB_ENABLED: "true",
    TWITCH_CLIENT_ID: "id",
    TWITCH_CLIENT_SECRET: "secret",
    EVENTSUB_SECRET: "hook",
    EVENTSUB_PUBLIC_URL: "https://example.com",
    EVENTSUB_BROADCASTER: "Kandyland, kandylandvods"
  };

  it("reports canManage when everything is present", () => {
    const config = readEventSubConfig(base);
    expect(config.canManage).toBe(true);
    expect(config.missing).toEqual([]);
    expect(config.broadcasters).toEqual(["kandyland", "kandylandvods"]);
    expect(config.callbackUrl).toBe(CALLBACK);
    expect(config.reconcileMinutes).toBe(60);
  });

  it("lists missing variables and refuses to manage", () => {
    const config = readEventSubConfig({ ...base, TWITCH_CLIENT_SECRET: "", EVENTSUB_SECRET: "" });
    expect(config.canManage).toBe(false);
    expect(config.missing).toEqual(["TWITCH_CLIENT_SECRET", "EVENTSUB_SECRET"]);
  });

  it("does not manage when EventSub is disabled", () => {
    expect(readEventSubConfig({ ...base, EVENTSUB_ENABLED: "false" }).canManage).toBe(false);
  });

  it("honours EVENTSUB_RECONCILE_MINUTES", () => {
    expect(readEventSubConfig({ ...base, EVENTSUB_RECONCILE_MINUTES: "15" }).reconcileMinutes).toBe(
      15
    );
    expect(readEventSubConfig({ ...base, EVENTSUB_RECONCILE_MINUTES: "0" }).reconcileMinutes).toBe(
      0
    );
  });
});

describe("ensureSubscriptions", () => {
  function jsonResponse(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body)
    };
  }

  it("deletes revoked subscriptions and creates missing ones via the Helix API", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const method = options.method || "GET";
      const body = typeof options.body === "string" ? JSON.parse(options.body) : null;
      calls.push({ method, url, body });

      if (url.startsWith("https://id.twitch.tv/oauth2/token")) {
        return jsonResponse({ access_token: "app-token" });
      }
      if (url.startsWith("https://api.twitch.tv/helix/users")) {
        return jsonResponse({ data: [{ id: "123", login: "kandyland" }] });
      }
      if (
        method === "GET" &&
        url.startsWith("https://api.twitch.tv/helix/eventsub/subscriptions")
      ) {
        return jsonResponse({
          data: [
            sub({ id: "dead", status: "notification_failures_exceeded" }),
            sub({ id: "ok-offline", type: "stream.offline" })
          ],
          pagination: {}
        });
      }
      if (method === "DELETE") {
        return jsonResponse({}, 204);
      }
      if (method === "POST") {
        return jsonResponse(
          { data: [{ id: "new", status: "webhook_callback_verification_pending" }] },
          202
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const summary = await ensureSubscriptions({
      clientId: "id",
      clientSecret: "secret",
      callbackUrl: CALLBACK,
      secret: "hook",
      broadcasters: ["kandyland"],
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      fetchImpl
    });

    expect(summary).toMatchObject({ created: 2, removed: 1, kept: 1 });

    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toContain("id=dead");

    const creates = calls.filter((c) => c.method === "POST" && c.url.includes("eventsub"));
    expect(creates.map((c) => c.body.type).sort()).toEqual(["channel.raid", "stream.online"]);
    for (const create of creates) {
      expect(create.body.transport).toEqual({
        method: "webhook",
        callback: CALLBACK,
        secret: "hook"
      });
    }
  });

  it("dry run reports the plan without mutating anything", async () => {
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const method = options.method || "GET";
      if (url.startsWith("https://id.twitch.tv/oauth2/token")) {
        return jsonResponse({ access_token: "app-token" });
      }
      if (url.startsWith("https://api.twitch.tv/helix/users")) {
        return jsonResponse({ data: [{ id: "123", login: "kandyland" }] });
      }
      if (method === "GET") {
        return jsonResponse({ data: [], pagination: {} });
      }
      throw new Error(`mutation attempted: ${method} ${url}`);
    });

    const summary = await ensureSubscriptions({
      clientId: "id",
      clientSecret: "secret",
      callbackUrl: CALLBACK,
      secret: "hook",
      broadcasters: ["kandyland"],
      dryRun: true,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      fetchImpl
    });

    expect(summary.created).toBe(3);
    expect(
      fetchImpl.mock.calls.some(
        ([, o]) => o?.method === "POST" && !String(o.body).includes("client_credentials")
      )
    ).toBe(false);
  });
});
