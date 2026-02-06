import { describe, it, expect, beforeEach, vi } from "vitest";

// Helper to create a mock Discord member
function mockMember({ roleIds = [], isAdmin = false } = {}) {
  const rolesCache = new Map(roleIds.map((id) => [id, { id }]));
  return {
    roles: {
      cache: {
        has: (id) => rolesCache.has(id)
      }
    },
    permissions: {
      has: (flag) => {
        // PermissionsBitField.Flags.Administrator = 8n
        if (flag === 8n) return isAdmin;
        return false;
      }
    }
  };
}

describe("permissions", () => {
  // We need to dynamically import permissions.js after setting env vars,
  // since it reads process.env at module level.

  describe("with ADMIN and MOD roles configured", () => {
    let hasPrivilegedRole, hasAdminRole, ADMIN_ROLE_IDS, MOD_ROLE_IDS;

    beforeEach(async () => {
      process.env.ADMIN_ROLE_ID = "111111111111111111";
      process.env.MOD_ROLE_ID = "222222222222222222";

      // Reset module cache to re-evaluate module-level code
      vi.resetModules();
      const mod = await import("../src/utils/permissions.js");
      hasPrivilegedRole = mod.hasPrivilegedRole;
      hasAdminRole = mod.hasAdminRole;
      ADMIN_ROLE_IDS = mod.ADMIN_ROLE_IDS;
      MOD_ROLE_IDS = mod.MOD_ROLE_IDS;
    });

    it("exports parsed ADMIN_ROLE_IDS", () => {
      expect(ADMIN_ROLE_IDS).toEqual(["111111111111111111"]);
    });

    it("exports parsed MOD_ROLE_IDS", () => {
      expect(MOD_ROLE_IDS).toEqual(["222222222222222222"]);
    });

    it("admin role grants privileged access", () => {
      const member = mockMember({ roleIds: ["111111111111111111"] });
      expect(hasPrivilegedRole(member)).toBe(true);
    });

    it("admin role grants admin access", () => {
      const member = mockMember({ roleIds: ["111111111111111111"] });
      expect(hasAdminRole(member)).toBe(true);
    });

    it("mod role grants privileged access", () => {
      const member = mockMember({ roleIds: ["222222222222222222"] });
      expect(hasPrivilegedRole(member)).toBe(true);
    });

    it("mod role does NOT grant admin access", () => {
      const member = mockMember({ roleIds: ["222222222222222222"] });
      expect(hasAdminRole(member)).toBe(false);
    });

    it("Administrator permission grants privileged access", () => {
      const member = mockMember({ isAdmin: true });
      expect(hasPrivilegedRole(member)).toBe(true);
    });

    it("Administrator permission grants admin access", () => {
      const member = mockMember({ isAdmin: true });
      expect(hasAdminRole(member)).toBe(true);
    });

    it("no matching role denies privileged access", () => {
      const member = mockMember({ roleIds: ["999999999999999999"] });
      expect(hasPrivilegedRole(member)).toBe(false);
    });

    it("no matching role denies admin access", () => {
      const member = mockMember({ roleIds: ["999999999999999999"] });
      expect(hasAdminRole(member)).toBe(false);
    });
  });

  describe("with comma-separated role IDs", () => {
    let hasPrivilegedRole, hasAdminRole, ADMIN_ROLE_IDS, MOD_ROLE_IDS;

    beforeEach(async () => {
      process.env.ADMIN_ROLE_ID = "111111111111111111,333333333333333333";
      process.env.MOD_ROLE_ID = "222222222222222222,444444444444444444";

      vi.resetModules();
      const mod = await import("../src/utils/permissions.js");
      hasPrivilegedRole = mod.hasPrivilegedRole;
      hasAdminRole = mod.hasAdminRole;
      ADMIN_ROLE_IDS = mod.ADMIN_ROLE_IDS;
      MOD_ROLE_IDS = mod.MOD_ROLE_IDS;
    });

    it("parses multiple admin role IDs", () => {
      expect(ADMIN_ROLE_IDS).toEqual(["111111111111111111", "333333333333333333"]);
    });

    it("parses multiple mod role IDs", () => {
      expect(MOD_ROLE_IDS).toEqual(["222222222222222222", "444444444444444444"]);
    });

    it("second admin role ID grants access", () => {
      const member = mockMember({ roleIds: ["333333333333333333"] });
      expect(hasAdminRole(member)).toBe(true);
    });

    it("second mod role ID grants access", () => {
      const member = mockMember({ roleIds: ["444444444444444444"] });
      expect(hasPrivilegedRole(member)).toBe(true);
    });
  });

  describe("with empty/undefined env vars", () => {
    let hasPrivilegedRole, hasAdminRole, ADMIN_ROLE_IDS, MOD_ROLE_IDS;

    beforeEach(async () => {
      delete process.env.ADMIN_ROLE_ID;
      delete process.env.MOD_ROLE_ID;

      vi.resetModules();
      const mod = await import("../src/utils/permissions.js");
      hasPrivilegedRole = mod.hasPrivilegedRole;
      hasAdminRole = mod.hasAdminRole;
      ADMIN_ROLE_IDS = mod.ADMIN_ROLE_IDS;
      MOD_ROLE_IDS = mod.MOD_ROLE_IDS;
    });

    it("ADMIN_ROLE_IDS is empty array", () => {
      expect(ADMIN_ROLE_IDS).toEqual([]);
    });

    it("MOD_ROLE_IDS is empty array", () => {
      expect(MOD_ROLE_IDS).toEqual([]);
    });

    it("Administrator permission still grants access", () => {
      const member = mockMember({ isAdmin: true });
      expect(hasPrivilegedRole(member)).toBe(true);
      expect(hasAdminRole(member)).toBe(true);
    });

    it("non-admin member is denied", () => {
      const member = mockMember({});
      expect(hasPrivilegedRole(member)).toBe(false);
      expect(hasAdminRole(member)).toBe(false);
    });
  });
});
