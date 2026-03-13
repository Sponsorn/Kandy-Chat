import { html } from "htm/preact";
import { useState, useEffect, useCallback } from "preact/hooks";
import { config, autoBan } from "../api.js";
import { canAdmin } from "../state.js";

function ConfigSection({ title, children, badge = null }) {
  return html`
    <div class="card" style="margin-bottom: 1rem;">
      <div class="card-header" style="display: flex; align-items: center; gap: 0.5rem;">
        <span class="card-title">${title}</span>
        ${badge &&
        html`<span class="badge" style="font-size: 0.7rem; padding: 0.2rem 0.5rem;"
          >${badge}</span
        >`}
      </div>
      <div class="card-body">${children}</div>
    </div>
  `;
}

function ConfigItem({ label, value }) {
  const displayValue = () => {
    if (value === null || value === undefined) return "Not set";
    if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
    if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
    return String(value);
  };

  return html`
    <div
      style="display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid var(--border-color);"
    >
      <span style="color: var(--text-secondary);">${label}</span>
      <span style="font-family: monospace;">${displayValue()}</span>
    </div>
  `;
}

function ToggleSwitch({ label, checked, onChange, disabled = false, description = null }) {
  // When disabled, always show toggle in "off" position with muted styling
  const effectiveChecked = disabled ? false : checked;

  return html`
    <div
      style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid var(--border-color);"
    >
      <div>
        <span style=${{ color: disabled ? "var(--text-muted)" : "var(--text-primary)" }}
          >${label}</span
        >
        ${description &&
        html`<p style="color: var(--text-secondary); font-size: 0.85rem; margin: 0.25rem 0 0 0;">
          ${description}
        </p>`}
      </div>
      <label
        class="toggle-switch"
        style="position: relative; display: inline-block; width: 48px; height: 26px;"
      >
        <input
          type="checkbox"
          checked=${checked}
          onChange=${(e) => onChange(e.target.checked)}
          disabled=${disabled}
          style="opacity: 0; width: 0; height: 0;"
        />
        <span
          style=${{
            position: "absolute",
            cursor: disabled ? "not-allowed" : "pointer",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: disabled
              ? "var(--bg-tertiary)"
              : effectiveChecked
                ? "var(--accent-primary)"
                : "var(--bg-hover)",
            border: disabled
              ? "1px solid var(--border-color)"
              : effectiveChecked
                ? "none"
                : "2px solid var(--border-color)",
            transition: "0.3s",
            borderRadius: "26px"
          }}
        >
          <span
            style=${{
              position: "absolute",
              content: "",
              height: "20px",
              width: "20px",
              left: effectiveChecked ? "25px" : "3px",
              bottom: disabled ? "2px" : "3px",
              backgroundColor: disabled ? "var(--text-muted)" : "white",
              transition: "0.3s",
              borderRadius: "50%"
            }}
          ></span>
        </span>
      </label>
    </div>
  `;
}

function TemplateEditor({ label, value, onChange, tags = [], placeholder = "" }) {
  const insertTag = (tag) => {
    const newValue = value + `{${tag}}`;
    onChange(newValue);
  };

  return html`
    <div style="margin-bottom: 1rem;">
      <label
        style="display: block; color: var(--text-secondary); margin-bottom: 0.5rem; font-size: 0.9rem;"
      >
        ${label}
      </label>
      <textarea
        value=${value}
        onInput=${(e) => onChange(e.target.value)}
        placeholder=${placeholder}
        style=${{
          width: "100%",
          minHeight: "80px",
          padding: "0.75rem",
          backgroundColor: "var(--bg-secondary)",
          border: "1px solid var(--border-color)",
          borderRadius: "4px",
          color: "var(--text-primary)",
          fontFamily: "monospace",
          fontSize: "0.9rem",
          resize: "vertical"
        }}
      />
      ${tags.length > 0 &&
      html`
        <div style="margin-top: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.25rem;">
          <span style="color: var(--text-secondary); font-size: 0.8rem; margin-right: 0.5rem;"
            >Insert tag:</span
          >
          ${tags.map(
            (tag) => html`
              <button
                type="button"
                onClick=${() => insertTag(tag)}
                style=${{
                  padding: "0.2rem 0.5rem",
                  fontSize: "0.75rem",
                  backgroundColor: "var(--bg-tertiary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "3px",
                  color: "var(--text-secondary)",
                  cursor: "pointer"
                }}
              >
                {${tag}}
              </button>
            `
          )}
        </div>
      `}
    </div>
  `;
}

function AutoBanSection() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newPattern, setNewPattern] = useState("");
  const [newIsRegex, setNewIsRegex] = useState(true);
  const [newFirstMsgOnly, setNewFirstMsgOnly] = useState(true);
  const [error, setError] = useState(null);
  const isAdmin = canAdmin.value;

  const loadRules = useCallback(async () => {
    try {
      const data = await autoBan.getRules();
      setRules(data.rules || []);
    } catch (err) {
      console.error("Failed to load auto-ban rules:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRules();
    const handler = () => loadRules();
    window.addEventListener("app:config-update", handler);
    return () => window.removeEventListener("app:config-update", handler);
  }, [loadRules]);

  const handleToggle = async (id, field, value) => {
    try {
      setError(null);
      await autoBan.updateRule(id, { [field]: value });
      setRules((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    } catch (err) {
      setError(err.message);
    }
  };

  const handleAdd = async () => {
    if (!newPattern.trim()) return;
    try {
      setError(null);
      const data = await autoBan.addRule({
        pattern: newPattern.trim(),
        isRegex: newIsRegex,
        flags: "i",
        enabled: true,
        firstMsgOnly: newFirstMsgOnly
      });
      setRules((prev) => [...prev, data.rule]);
      setNewPattern("");
      setShowAddForm(false);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRemove = async (id) => {
    try {
      setError(null);
      await autoBan.removeRule(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) {
    return html`<${ConfigSection} title="Auto Ban Rules" badge="Loading...">
      <p style="color: var(--text-secondary);">Loading...</p>
    </${ConfigSection}>`;
  }

  return html`
    <${ConfigSection} title="Auto Ban Rules" badge=${isAdmin ? "Editable" : "View only"}>
      ${error && html`<p style="color: var(--error-color); margin-bottom: 0.5rem;">${error}</p>`}
      ${
        rules.length === 0
          ? html`<p style="color: var(--text-secondary); padding: 0.5rem 0;">
              No auto-ban rules configured.
            </p>`
          : html`
              <div style="overflow-x: auto;">
                <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
                  <thead>
                    <tr style="border-bottom: 2px solid var(--border-color);">
                      <th style="text-align: left; padding: 0.5rem; color: var(--text-secondary);">
                        Pattern
                      </th>
                      <th
                        style="text-align: center; padding: 0.5rem; color: var(--text-secondary);"
                      >
                        First-msg
                      </th>
                      <th
                        style="text-align: center; padding: 0.5rem; color: var(--text-secondary);"
                      >
                        Enabled
                      </th>
                      ${isAdmin &&
                      html`<th
                        style="text-align: center; padding: 0.5rem; color: var(--text-secondary);"
                      ></th>`}
                    </tr>
                  </thead>
                  <tbody>
                    ${rules.map(
                      (rule) => html`
                        <tr style="border-bottom: 1px solid var(--border-color);">
                          <td
                            style="padding: 0.5rem; font-family: monospace; font-size: 0.85rem; word-break: break-all;"
                          >
                            ${rule.isRegex
                              ? html`<span style="color: var(--accent-primary);"
                                  >/${rule.pattern}/${rule.flags || "i"}</span
                                >`
                              : rule.pattern}
                          </td>
                          <td style="text-align: center; padding: 0.5rem;">
                            <input
                              type="checkbox"
                              checked=${rule.firstMsgOnly}
                              onChange=${(e) =>
                                handleToggle(rule.id, "firstMsgOnly", e.target.checked)}
                              disabled=${!isAdmin}
                              style="cursor: ${isAdmin ? "pointer" : "not-allowed"};"
                            />
                          </td>
                          <td style="text-align: center; padding: 0.5rem;">
                            <input
                              type="checkbox"
                              checked=${rule.enabled}
                              onChange=${(e) => handleToggle(rule.id, "enabled", e.target.checked)}
                              disabled=${!isAdmin}
                              style="cursor: ${isAdmin ? "pointer" : "not-allowed"};"
                            />
                          </td>
                          ${isAdmin &&
                          html`
                            <td style="text-align: center; padding: 0.5rem;">
                              <button
                                onClick=${() => handleRemove(rule.id)}
                                style="background: none; border: none; color: var(--error-color); cursor: pointer; font-size: 1rem;"
                                title="Remove rule"
                              >
                                ✕
                              </button>
                            </td>
                          `}
                        </tr>
                      `
                    )}
                  </tbody>
                </table>
              </div>
            `
      }
      ${
        isAdmin &&
        !showAddForm &&
        html`
          <button
            onClick=${() => setShowAddForm(true)}
            class="btn btn-sm"
            style="margin-top: 0.75rem;"
          >
            + Add Rule
          </button>
        `
      }
      ${
        isAdmin &&
        showAddForm &&
        html`
          <div
            style="margin-top: 0.75rem; padding: 0.75rem; border: 1px solid var(--border-color); border-radius: 6px;"
          >
            <div style="margin-bottom: 0.5rem;">
              <input
                type="text"
                value=${newPattern}
                onInput=${(e) => setNewPattern(e.target.value)}
                placeholder=${newIsRegex ? "Regex pattern (e.g. \\w+\\s+\\.com)" : "Text to match"}
                style="width: 100%; padding: 0.5rem; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-family: monospace;"
              />
            </div>
            <div style="display: flex; gap: 1rem; align-items: center; margin-bottom: 0.5rem;">
              <label style="display: flex; align-items: center; gap: 0.25rem; cursor: pointer;">
                <input
                  type="checkbox"
                  checked=${newIsRegex}
                  onChange=${(e) => setNewIsRegex(e.target.checked)}
                />
                Regex
              </label>
              <label style="display: flex; align-items: center; gap: 0.25rem; cursor: pointer;">
                <input
                  type="checkbox"
                  checked=${newFirstMsgOnly}
                  onChange=${(e) => setNewFirstMsgOnly(e.target.checked)}
                />
                First-msg only
              </label>
            </div>
            <div style="display: flex; gap: 0.5rem;">
              <button
                onClick=${handleAdd}
                class="btn btn-sm"
                style="background: var(--accent-primary);"
              >
                Add
              </button>
              <button
                onClick=${() => {
                  setShowAddForm(false);
                  setNewPattern("");
                  setError(null);
                }}
                class="btn btn-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        `
      }
    </${ConfigSection}>
  `;
}

export function ConfigPanel() {
  const [configData, setConfigData] = useState(null);
  const [channels, setChannels] = useState(null);
  const [filters, setFilters] = useState(null);
  const [subMessages, setSubMessages] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState(null);

  // Editable state
  const [editedFilters, setEditedFilters] = useState({});
  const [editedSubMessages, setEditedSubMessages] = useState({});
  const [hasFilterChanges, setHasFilterChanges] = useState(false);
  const [hasSubMessageChanges, setHasSubMessageChanges] = useState(false);

  const isAdmin = canAdmin.value;

  const loadAllConfig = useCallback(async () => {
    try {
      setLoading(true);
      const [configResult, channelsResult, filtersResult, subMessagesResult] = await Promise.all([
        config.get(),
        config.getChannels(),
        config.getFilters(),
        config.getSubscriptionMessages()
      ]);
      setConfigData(configResult);
      setChannels(channelsResult);
      setFilters(filtersResult);
      setSubMessages(subMessagesResult);

      // Initialize editable state from loaded data
      setEditedFilters({
        blockCommands: filtersResult.blockCommands,
        blockEmotes: filtersResult.blockEmotes,
        suspiciousFlagEnabled: configResult?.filters?.suspiciousFlagEnabled ?? true
      });
      setEditedSubMessages({
        sub: { ...subMessagesResult.sub },
        resub: { ...subMessagesResult.resub },
        giftSub: { ...subMessagesResult.giftSub }
      });
      setHasFilterChanges(false);
      setHasSubMessageChanges(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    const doLoad = async () => {
      if (mounted) {
        await loadAllConfig();
      }
    };
    doLoad();

    return () => {
      mounted = false;
    };
  }, [loadAllConfig]);

  // Handle WebSocket config updates
  useEffect(() => {
    let mounted = true;

    const handleConfigUpdate = () => {
      if (mounted) {
        loadAllConfig();
      }
    };
    window.addEventListener("app:config-update", handleConfigUpdate);
    return () => {
      mounted = false;
      window.removeEventListener("app:config-update", handleConfigUpdate);
    };
  }, [loadAllConfig]);

  const handleFilterChange = (key, value) => {
    setEditedFilters((prev) => ({ ...prev, [key]: value }));
    setHasFilterChanges(true);
  };

  const handleSubMessageChange = (type, key, value) => {
    setEditedSubMessages((prev) => ({
      ...prev,
      [type]: { ...prev[type], [key]: value }
    }));
    setHasSubMessageChanges(true);
  };

  const saveFilters = async () => {
    if (!isAdmin || !hasFilterChanges) return;

    try {
      setSaving(true);
      setSaveMessage(null);
      await config.updateFilters(editedFilters);
      setHasFilterChanges(false);
      setSaveMessage({ type: "success", text: "Filter settings saved successfully" });
      // Reload to get fresh data
      await loadAllConfig();
    } catch (err) {
      setSaveMessage({ type: "error", text: `Failed to save: ${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  const saveSubMessages = async () => {
    if (!isAdmin || !hasSubMessageChanges) return;

    try {
      setSaving(true);
      setSaveMessage(null);
      await config.updateSubscriptionMessages(editedSubMessages);
      setHasSubMessageChanges(false);
      setSaveMessage({ type: "success", text: "Subscription messages saved successfully" });
      // Reload to get fresh data
      await loadAllConfig();
    } catch (err) {
      setSaveMessage({ type: "error", text: `Failed to save: ${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return html`
      <div class="loading">
        <div class="loading-spinner"></div>
        <p>Loading configuration...</p>
      </div>
    `;
  }

  if (error) {
    return html` <div class="alert alert-error">Failed to load configuration: ${error}</div> `;
  }

  const allTags = subMessages?.availableTags?.all || ["user", "tier", "channel"];
  const resubTags = [
    ...allTags,
    ...(subMessages?.availableTags?.resub || ["months", "streak_months", "message"])
  ];
  const giftSingleTags = [
    ...allTags,
    ...(subMessages?.availableTags?.giftSub?.single || ["recipient"])
  ];
  const giftMultipleTags = [
    ...allTags,
    ...(subMessages?.availableTags?.giftSub?.multiple || ["recipient_count"])
  ];

  return html`
    <div>
      ${saveMessage &&
      html`
        <div
          class="alert ${saveMessage.type === "error" ? "alert-error" : "alert-success"}"
          style="margin-bottom: 1rem;"
        >
          ${saveMessage.text}
        </div>
      `}

      <${ConfigSection} title="Channels" badge="Read-only">
        <${ConfigItem} label="Twitch Channels" value=${channels?.twitch} />
        <${ConfigItem} label="Relay Filter" value=${channels?.relayFilter || "All channels"} />
        <${ConfigItem}
          label="Channel Mapping"
          value=${Object.keys(channels?.mapping || {}).length > 0
            ? Object.entries(channels.mapping)
                .map(([t, d]) => `${t} → ${d}`)
                .join(", ")
            : "No mapping configured"}
        />
        <p
          style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 0.75rem; padding: 0.5rem; background: var(--bg-tertiary); border-radius: 4px;"
        >
          Channel configuration requires editing .env and restarting the bot.
        </p>
      <//>

      <${ConfigSection} title="Message Filters" badge=${isAdmin ? "Editable" : "View only"}>
        <${ToggleSwitch}
          label="Block Commands"
          description="Filter out messages starting with ! (Twitch commands)"
          checked=${editedFilters.blockCommands}
          onChange=${(v) => handleFilterChange("blockCommands", v)}
          disabled=${!isAdmin}
        />
        <${ToggleSwitch}
          label="Block Emote-Only Messages"
          description="Filter out messages containing only emotes"
          checked=${editedFilters.blockEmotes}
          onChange=${(v) => handleFilterChange("blockEmotes", v)}
          disabled=${!isAdmin}
        />
        <${ToggleSwitch}
          label="Suspicious Flag"
          description="Add warning emoji to messages matching blacklist patterns"
          checked=${editedFilters.suspiciousFlagEnabled}
          onChange=${(v) => handleFilterChange("suspiciousFlagEnabled", v)}
          disabled=${!isAdmin}
        />
        <${ConfigItem} label="Blocked Words Count" value=${filters?.blockedWordsCount} />
        <${ConfigItem} label="Blocked Regex Count" value=${filters?.blockedRegexCount} />

        ${isAdmin &&
        hasFilterChanges &&
        html`
          <div style="margin-top: 1rem; display: flex; gap: 0.5rem;">
            <button
              onClick=${saveFilters}
              disabled=${saving}
              style=${{
                padding: "0.5rem 1rem",
                backgroundColor: "var(--accent-primary)",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: saving ? "not-allowed" : "pointer",
                opacity: saving ? 0.7 : 1
              }}
            >
              ${saving ? "Saving..." : "Save Filter Settings"}
            </button>
            <button
              onClick=${loadAllConfig}
              disabled=${saving}
              style=${{
                padding: "0.5rem 1rem",
                backgroundColor: "var(--bg-tertiary)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-color)",
                borderRadius: "4px",
                cursor: saving ? "not-allowed" : "pointer"
              }}
            >
              Cancel
            </button>
          </div>
        `}
      <//>

      <${AutoBanSection} />

      <${ConfigSection} title="Subscription Messages" badge=${isAdmin ? "Editable" : "View only"}>
        <h4 style="color: var(--text-primary); margin: 0 0 0.75rem 0; font-size: 1rem;">
          New Subscription
        </h4>
        <${ToggleSwitch}
          label="Enable Thank You Message"
          checked=${editedSubMessages.sub?.enabled !== false}
          onChange=${(v) => handleSubMessageChange("sub", "enabled", v)}
          disabled=${!isAdmin}
        />
        ${isAdmin
          ? html`
              <${TemplateEditor}
                label="Message Template"
                value=${editedSubMessages.sub?.message || ""}
                onChange=${(v) => handleSubMessageChange("sub", "message", v)}
                tags=${allTags}
                placeholder="hype Welcome to Kandyland, {user}! kandyKiss"
              />
            `
          : html` <${ConfigItem} label="Message" value=${editedSubMessages.sub?.message} /> `}

        <h4 style="color: var(--text-primary); margin: 1.5rem 0 0.75rem 0; font-size: 1rem;">
          Resub
        </h4>
        <${ToggleSwitch}
          label="Enable Thank You Message"
          checked=${editedSubMessages.resub?.enabled !== false}
          onChange=${(v) => handleSubMessageChange("resub", "enabled", v)}
          disabled=${!isAdmin}
        />
        ${isAdmin
          ? html`
              <${TemplateEditor}
                label="Message Template"
                value=${editedSubMessages.resub?.message || ""}
                onChange=${(v) => handleSubMessageChange("resub", "message", v)}
                tags=${resubTags}
                placeholder="hype Welcome back, {user}! {months} months! kandyKiss"
              />
            `
          : html` <${ConfigItem} label="Message" value=${editedSubMessages.resub?.message} /> `}

        <h4 style="color: var(--text-primary); margin: 1.5rem 0 0.75rem 0; font-size: 1rem;">
          Gift Subscription
        </h4>
        <${ToggleSwitch}
          label="Enable Thank You Message"
          checked=${editedSubMessages.giftSub?.enabled !== false}
          onChange=${(v) => handleSubMessageChange("giftSub", "enabled", v)}
          disabled=${!isAdmin}
        />
        ${isAdmin
          ? html`
              <${TemplateEditor}
                label="Single Gift Template"
                value=${editedSubMessages.giftSub?.messageSingle || ""}
                onChange=${(v) => handleSubMessageChange("giftSub", "messageSingle", v)}
                tags=${giftSingleTags}
                placeholder="Thank you for gifting to {recipient}, {user}! kandyHype"
              />
              <${TemplateEditor}
                label="Multiple Gifts Template"
                value=${editedSubMessages.giftSub?.messageMultiple || ""}
                onChange=${(v) => handleSubMessageChange("giftSub", "messageMultiple", v)}
                tags=${giftMultipleTags}
                placeholder="Thank you for gifting to {recipient_count} users, {user}! kandyHype"
              />
            `
          : html`
              <${ConfigItem}
                label="Single Gift"
                value=${editedSubMessages.giftSub?.messageSingle}
              />
              <${ConfigItem}
                label="Multiple Gifts"
                value=${editedSubMessages.giftSub?.messageMultiple}
              />
            `}
        ${isAdmin &&
        hasSubMessageChanges &&
        html`
          <div style="margin-top: 1rem; display: flex; gap: 0.5rem;">
            <button
              onClick=${saveSubMessages}
              disabled=${saving}
              style=${{
                padding: "0.5rem 1rem",
                backgroundColor: "var(--accent-primary)",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: saving ? "not-allowed" : "pointer",
                opacity: saving ? 0.7 : 1
              }}
            >
              ${saving ? "Saving..." : "Save Subscription Messages"}
            </button>
            <button
              onClick=${loadAllConfig}
              disabled=${saving}
              style=${{
                padding: "0.5rem 1rem",
                backgroundColor: "var(--bg-tertiary)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-color)",
                borderRadius: "4px",
                cursor: saving ? "not-allowed" : "pointer"
              }}
            >
              Cancel
            </button>
          </div>
        `}
      <//>

      <${ConfigSection} title="Alert Roles" badge="Read-only">
        <${ConfigItem}
          label="Reaction Timeout"
          value=${`${configData?.filters?.reactionTimeoutSeconds}s`}
        />
        <${ConfigItem}
          label="Freeze Alert Role"
          value=${configData?.alerts?.freezeAlertRoleId || "Not set"}
        />
        <${ConfigItem}
          label="Stream Alert Role"
          value=${configData?.alerts?.streamAlertRoleId || "Not set"}
        />
        <p
          style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 0.75rem; padding: 0.5rem; background: var(--bg-tertiary); border-radius: 4px;"
        >
          Alert role configuration requires editing .env and restarting the bot.
        </p>
      <//>
    </div>
  `;
}
