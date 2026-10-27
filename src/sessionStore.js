/**
 * Unified SessionStore with Centralized Sliding TTL
 * Eliminates synchronous inline `delete` race conditions and memory leaks.
 */

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes inactivity timeout
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Run garbage collection every 5 minutes

class SessionStore {
  constructor() {
    this._store = new Map();

    // Periodic sweep for abandoned sessions
    this._cleaner = setInterval(() => {
      this.evictExpired();
    }, CLEANUP_INTERVAL_MS);

    // Prevent timer from hanging process exit
    if (this._cleaner.unref) {
      this._cleaner.unref();
    }
  }

  /**
   * Generates a pristine session template.
   * @param {string} jid
   * @returns {object}
   */
  _createDefaultSession(jid) {
    return {
      jid,
      step: 'IDLE',
      track: null,
      data: {},
      lastActive: Date.now(),
      createdAt: Date.now(),
    };
  }

  /**
   * Retrieves or initializes a session for a user.
   * Slides the activity TTL window automatically.
   * @param {string} jid
   * @returns {object}
   */
  get(jid) {
    const now = Date.now();
    const existing = this._store.get(jid);

    if (existing) {
      if (now - existing.lastActive < SESSION_TTL_MS) {
        existing.lastActive = now;
        return existing;
      }
      // Expired: reset cleanly
      this._store.delete(jid);
    }

    const fresh = this._createDefaultSession(jid);
    this._store.set(jid, fresh);
    return fresh;
  }

  /**
   * Updates or modifies fields within a user's session.
   * @param {string} jid
   * @param {object} updates
   */
  set(jid, updates) {
    const session = this.get(jid);
    Object.assign(session, updates, { lastActive: Date.now() });
    this._store.set(jid, session);
    return session;
  }

  /**
   * Resets an active session to IDLE state without destroying the store reference.
   * @param {string} jid
   */
  reset(jid) {
    const fresh = this._createDefaultSession(jid);
    this._store.set(jid, fresh);
    return fresh;
  }

  /**
   * Checks if a user has an active session in progress (non-IDLE).
   * @param {string} jid
   * @returns {boolean}
   */
  hasActiveSession(jid) {
    const session = this._store.get(jid);
    if (!session) return false;
    const isExpired = Date.now() - session.lastActive >= SESSION_TTL_MS;
    return !isExpired && session.step !== 'IDLE';
  }

  /**
   * Checks if session exists in memory.
   * @param {string} jid
   * @returns {boolean}
   */
  hasSession(jid) {
    return this._store.has(jid);
  }

  getSession(jid) {
    return this.get(jid);
  }

  resetSession(jid) {
    return this.reset(jid);
  }

  /**
   * Evicts all sessions that have exceeded the 30-minute inactivity window.
   */
  evictExpired() {
    const now = Date.now();
    for (const [jid, session] of this._store.entries()) {
      if (now - session.lastActive >= SESSION_TTL_MS) {
        this._store.delete(jid);
      }
    }
  }

  /**
   * Returns current active session count.
   */
  size() {
    return this._store.size;
  }

  /**
   * Destroys all sessions (useful for tests).
   */
  clear() {
    this._store.clear();
  }
}

export const sessionStore = new SessionStore();
export const getSession = (jid) => sessionStore.get(jid);
export const resetSession = (jid) => sessionStore.reset(jid);
export default sessionStore;
