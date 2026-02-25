import { html } from "htm/preact";
import { useState, useEffect, useMemo } from "preact/hooks";
import { emojiMappingsData, fetchEmojiMappings } from "../state.js";
import { emojiMappings } from "../api.js";

function EmojiTag({ emoji, onRemove }) {
  const [removing, setRemoving] = useState(false);

  const handleRemove = async () => {
    setRemoving(true);
    try {
      await onRemove(emoji);
    } finally {
      setRemoving(false);
    }
  };

  return html`
    <span class="emoji-tag">
      <code>${emoji}</code>
      <button
        class="emoji-tag-remove"
        onClick=${handleRemove}
        disabled=${removing}
        title="Remove"
      >
        ${removing ? "..." : "\u2715"}
      </button>
    </span>
  `;
}

function EmojiGroup({ replacement, emojis, onRemoveEmoji, onAddEmoji }) {
  const [newEmoji, setNewEmoji] = useState("");
  const [adding, setAdding] = useState(false);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!newEmoji.trim()) return;
    setAdding(true);
    try {
      await onAddEmoji(newEmoji.trim(), replacement);
      setNewEmoji("");
    } finally {
      setAdding(false);
    }
  };

  const displayReplacement = replacement === "" ? "(strip)" : replacement;

  return html`
    <div class="emoji-group">
      <div class="emoji-group-header">
        <span class="emoji-group-replacement">
          ${replacement ? html`<span class="emoji-preview">${replacement}</span>` : ""}
          <code>${displayReplacement}</code>
        </span>
      </div>
      <div class="emoji-group-tags">
        ${emojis.map(
          (emoji) => html`
            <${EmojiTag} key=${emoji} emoji=${emoji} onRemove=${onRemoveEmoji} />
          `
        )}
        <form class="emoji-add-inline" onSubmit=${handleAdd}>
          <input
            type="text"
            class="form-input emoji-add-input"
            placeholder=":emoji:"
            value=${newEmoji}
            onInput=${(e) => setNewEmoji(e.target.value)}
            disabled=${adding}
          />
          <button type="submit" class="btn btn-sm" disabled=${adding || !newEmoji.trim()}>+</button>
        </form>
      </div>
    </div>
  `;
}

export function EmojiMappingsEditor() {
  const [mappings, setMappings] = useState(emojiMappingsData.value);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [newReplacement, setNewReplacement] = useState("");
  const [newEmoji, setNewEmoji] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    fetchEmojiMappings();

    const handleUpdate = () => {
      setMappings({ ...emojiMappingsData.value });
    };

    window.addEventListener("app:emoji-mappings-update", handleUpdate);
    return () => window.removeEventListener("app:emoji-mappings-update", handleUpdate);
  }, []);

  // Group emojis by replacement value
  const groups = useMemo(() => {
    const grouped = {};
    for (const [emoji, replacement] of Object.entries(mappings)) {
      if (
        searchTerm &&
        !emoji.toLowerCase().includes(searchTerm.toLowerCase()) &&
        !replacement.toLowerCase().includes(searchTerm.toLowerCase())
      ) {
        continue;
      }
      if (!grouped[replacement]) {
        grouped[replacement] = [];
      }
      grouped[replacement].push(emoji);
    }
    // Sort groups: non-empty replacements first (alphabetically), then empty (strip)
    const sorted = Object.entries(grouped).sort(([a], [b]) => {
      if (a === "" && b !== "") return 1;
      if (a !== "" && b === "") return -1;
      return a.localeCompare(b);
    });
    return sorted;
  }, [mappings, searchTerm]);

  const totalMappings = Object.keys(mappings).length;

  const handleRemoveEmoji = async (emoji) => {
    setError(null);
    setSuccess(null);
    try {
      const result = await emojiMappings.remove(emoji);
      if (result.success) {
        setSuccess(`Removed mapping for "${emoji}"`);
        fetchEmojiMappings();
      } else {
        setError(result.message || "Failed to remove");
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const handleAddEmoji = async (emoji, replacement) => {
    setError(null);
    setSuccess(null);
    try {
      const result = await emojiMappings.add(emoji, replacement);
      if (result.success) {
        setSuccess(result.message);
        fetchEmojiMappings();
      } else {
        setError(result.message || "Failed to add");
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const handleAddGroup = async (e) => {
    e.preventDefault();
    if (!newEmoji.trim()) return;
    await handleAddEmoji(newEmoji.trim(), newReplacement);
    setNewEmoji("");
    setNewReplacement("");
  };

  return html`
    <div class="card">
      <div class="card-header">
        <span class="card-title">Emoji Mappings</span>
        <span class="text-muted">${totalMappings} mappings</span>
      </div>
      <div class="card-body">
        ${error &&
        html`<div class="alert alert-error" style="margin-bottom: 1rem;">${error}</div>`}
        ${success &&
        html`<div class="alert alert-success" style="margin-bottom: 1rem;">${success}</div>`}

        <form onSubmit=${handleAddGroup} style="margin-bottom: 1rem;">
          <p style="margin-bottom: 0.5rem; color: var(--text-muted); font-size: 0.75rem;">
            Add a new mapping group. Leave replacement empty to strip the emoji.
          </p>
          <div style="display: flex; gap: 0.5rem;">
            <input
              type="text"
              class="form-input"
              placeholder=":youtube_emoji:"
              value=${newEmoji}
              onInput=${(e) => setNewEmoji(e.target.value)}
              style="flex: 1;"
            />
            <input
              type="text"
              class="form-input"
              placeholder="Replacement (or empty to strip)"
              value=${newReplacement}
              onInput=${(e) => setNewReplacement(e.target.value)}
              style="flex: 1;"
            />
            <button type="submit" class="btn btn-primary" disabled=${!newEmoji.trim()}>
              Add
            </button>
          </div>
        </form>

        ${totalMappings > 5 &&
        html`
          <div style="margin-bottom: 1rem;">
            <input
              type="text"
              class="form-input"
              placeholder="Search mappings..."
              value=${searchTerm}
              onInput=${(e) => setSearchTerm(e.target.value)}
            />
          </div>
        `}

        ${groups.length === 0
          ? html`
              <div class="empty-state">
                <div class="empty-state-icon">\u{1F504}</div>
                <p>${searchTerm ? "No mappings match your search" : "No emoji mappings configured"}</p>
              </div>
            `
          : html`
              <div class="emoji-groups">
                ${groups.map(
                  ([replacement, emojis]) => html`
                    <${EmojiGroup}
                      key=${replacement}
                      replacement=${replacement}
                      emojis=${emojis}
                      onRemoveEmoji=${handleRemoveEmoji}
                      onAddEmoji=${handleAddEmoji}
                    />
                  `
                )}
              </div>
            `}
      </div>
    </div>
  `;
}
