import { html } from "htm/preact";
import { useState, useEffect } from "preact/hooks";
import { blacklistWords, blacklistRegex, fetchBlacklist } from "../state.js";
import { blacklist } from "../api.js";

function BlacklistItem({ word, type, onRemove }) {
  const [removing, setRemoving] = useState(false);

  const handleRemove = async () => {
    setRemoving(true);
    try {
      await onRemove(word);
    } finally {
      setRemoving(false);
    }
  };

  return html`
    <div class="blacklist-item">
      <span class="blacklist-word">${word}</span>
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        <span class="blacklist-type">${type}</span>
        <button
          class="btn-icon"
          onClick=${handleRemove}
          disabled=${removing}
          title="Remove"
        >
          ${removing ? "..." : "✕"}
        </button>
      </div>
    </div>
  `;
}

export function BlacklistEditor() {
  const [newWord, setNewWord] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [words, setWords] = useState(blacklistWords.value);
  const [regexes, setRegexes] = useState(blacklistRegex.value);

  useEffect(() => {
    fetchBlacklist();

    const handleUpdate = () => {
      setWords([...blacklistWords.value]);
      setRegexes([...blacklistRegex.value]);
    };

    window.addEventListener("app:blacklist-update", handleUpdate);
    return () => window.removeEventListener("app:blacklist-update", handleUpdate);
  }, []);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!newWord.trim()) return;

    setAdding(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await blacklist.add(newWord.trim());
      if (result.success) {
        setSuccess(`Added "${newWord.trim()}" to blacklist`);
        setNewWord("");
        fetchBlacklist();
      } else {
        setError(result.message || "Failed to add");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (word) => {
    setError(null);
    setSuccess(null);

    try {
      const result = await blacklist.remove(word);
      if (result.success) {
        setSuccess(`Removed "${word}" from blacklist`);
        fetchBlacklist();
      } else {
        setError(result.message || "Failed to remove");
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const total = words.length + regexes.length;

  return html`
    <div class="card">
      <div class="card-header">
        <span class="card-title">Blacklist</span>
        <span class="text-muted">${total} entries</span>
      </div>
      <div class="card-body">
        ${error && html`
          <div class="alert alert-error" style="margin-bottom: 1rem;">
            ${error}
          </div>
        `}
        ${success && html`
          <div class="alert alert-success" style="margin-bottom: 1rem;">
            ${success}
          </div>
        `}

        <form onSubmit=${handleAdd} style="margin-bottom: 1rem;">
          <div style="display: flex; gap: 0.5rem;">
            <input
              type="text"
              class="form-input"
              placeholder="Add word or /regex/flags..."
              value=${newWord}
              onInput=${(e) => setNewWord(e.target.value)}
              disabled=${adding}
            />
            <button type="submit" class="btn btn-primary" disabled=${adding || !newWord.trim()}>
              ${adding ? "Adding..." : "Add"}
            </button>
          </div>
          <p style="margin-top: 0.5rem; color: var(--text-muted); font-size: 0.75rem;">
            Use /pattern/flags format for regex patterns (e.g., /badword\\d+/i)
          </p>
        </form>

        ${total === 0 ? html`
          <div class="empty-state">
            <div class="empty-state-icon">🚫</div>
            <p>Blacklist is empty</p>
          </div>
        ` : html`
          <div class="blacklist-list">
            ${words.length > 0 && html`
              <div style="padding: 0.5rem 0.75rem; background: var(--bg-tertiary); font-weight: 500; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;">
                Words (${words.length})
              </div>
              ${words.map(word => html`
                <${BlacklistItem}
                  key=${word}
                  word=${word}
                  type="word"
                  onRemove=${handleRemove}
                />
              `)}
            `}

            ${regexes.length > 0 && html`
              <div style="padding: 0.5rem 0.75rem; background: var(--bg-tertiary); font-weight: 500; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; margin-top: ${words.length > 0 ? "1rem" : "0"};">
                Regex Patterns (${regexes.length})
              </div>
              ${regexes.map(regex => html`
                <${BlacklistItem}
                  key=${regex}
                  word=${regex}
                  type="regex"
                  onRemove=${handleRemove}
                />
              `)}
            `}
          </div>
        `}
      </div>
    </div>
  `;
}
