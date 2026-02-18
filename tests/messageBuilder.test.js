import { describe, it, expect } from "vitest";
import {
  buildNormalV2Message,
  buildSuspiciousV2Message,
  buildDisabledV2Message,
  buildDeletedV2Message
} from "../src/services/messageBuilder.js";
import { MessageFlags } from "discord.js";

describe("buildNormalV2Message", () => {
  it("returns V2 flag and a container with text display", () => {
    const result = buildNormalV2Message("hello world");
    expect(result.flags).toBe(MessageFlags.IsComponentsV2);
    expect(result.components).toHaveLength(1);

    const container = result.components[0].toJSON();
    expect(container.type).toBe(17); // Container
    // Should have exactly one TextDisplay child
    const textDisplays = container.components.filter((c) => c.type === 10);
    expect(textDisplays).toHaveLength(1);
    expect(textDisplays[0].content).toBe("hello world");
  });

  it("does not include buttons", () => {
    const result = buildNormalV2Message("test");
    const container = result.components[0].toJSON();
    const actionRows = container.components.filter((c) => c.type === 1);
    expect(actionRows).toHaveLength(0);
  });
});

describe("buildSuspiciousV2Message", () => {
  it("returns V2 flag with red accent color", () => {
    const result = buildSuspiciousV2Message("bad message", "badword");
    expect(result.flags).toBe(MessageFlags.IsComponentsV2);

    const container = result.components[0].toJSON();
    expect(container.accent_color).toBe(0xed4245);
  });

  it("includes warning text with matched word", () => {
    const result = buildSuspiciousV2Message("some text", "spam");
    const container = result.components[0].toJSON();
    const textDisplays = container.components.filter((c) => c.type === 10);
    const warningText = textDisplays.find((t) => t.content.includes("Suspicious"));
    expect(warningText).toBeDefined();
    expect(warningText.content).toContain("[spam]");
  });

  it("includes 3 buttons with correct custom IDs", () => {
    const result = buildSuspiciousV2Message("text", "word");
    const container = result.components[0].toJSON();
    const actionRow = container.components.find((c) => c.type === 1);
    expect(actionRow).toBeDefined();
    expect(actionRow.components).toHaveLength(3);

    const ids = actionRow.components.map((b) => b.custom_id);
    expect(ids).toEqual(["mod-delete", "mod-timeout", "mod-ban"]);
  });

  it("has buttons enabled by default", () => {
    const result = buildSuspiciousV2Message("text", "word");
    const container = result.components[0].toJSON();
    const actionRow = container.components.find((c) => c.type === 1);
    for (const button of actionRow.components) {
      expect(button.disabled).toBeFalsy();
    }
  });
});

describe("buildDisabledV2Message", () => {
  it("has all buttons disabled", () => {
    const result = buildDisabledV2Message("text", "word", "Deleted by mod");
    const container = result.components[0].toJSON();
    const actionRow = container.components.find((c) => c.type === 1);
    expect(actionRow).toBeDefined();
    for (const button of actionRow.components) {
      expect(button.disabled).toBe(true);
    }
  });

  it("shows action label", () => {
    const result = buildDisabledV2Message("text", "word", "Banned by admin");
    const container = result.components[0].toJSON();
    const textDisplays = container.components.filter((c) => c.type === 10);
    const actionLabel = textDisplays.find((t) => t.content.includes("Banned by admin"));
    expect(actionLabel).toBeDefined();
  });

  it("retains red accent color", () => {
    const result = buildDisabledV2Message("text", "word", "action");
    const container = result.components[0].toJSON();
    expect(container.accent_color).toBe(0xed4245);
  });
});

describe("buildDeletedV2Message", () => {
  it("wraps text in strikethrough", () => {
    const result = buildDeletedV2Message("original text");
    const container = result.components[0].toJSON();
    const textDisplays = container.components.filter((c) => c.type === 10);
    expect(textDisplays).toHaveLength(1);
    expect(textDisplays[0].content).toBe("~~original text~~ (deleted)");
  });

  it("returns V2 flag", () => {
    const result = buildDeletedV2Message("text");
    expect(result.flags).toBe(MessageFlags.IsComponentsV2);
  });
});
