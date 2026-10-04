// Browser, sessions and pages (data-models §3). Plain data only.

export type BrowserChannel = 'chrome' | 'msedge' | 'chromium';

export interface BrowserProfile {
  id: string; // prf_...
  name: string; // unique, /^[a-z0-9][a-z0-9-]{0,31}$/
  channel: BrowserChannel;
  userDataDir: string; // absolute; ALWAYS <dataDir>/profiles/<name> (ADR-003)
  headless: boolean; // default false (real sites + human takeover need a visible window)
  createdAt: number;
  lastUsedAt: number | null;
}

export type SessionStatus =
  | 'starting'
  | 'ready'
  | 'busy' // an action is executing
  | 'waiting_for_human'
  | 'disconnected' // browser gone or CDP dropped; reconnect possible
  | 'closed';

export interface Session {
  id: string; // ses_...
  profileId: string;
  status: SessionStatus;
  ownership: 'launched' | 'attached'; // launched = Browser-OS started the process
  headless: boolean;
  browserPid: number | null; // may be null with persistent contexts (integration §13)
  cdpPort: number | null; // internal; always null in protocol responses
  activePageId: string | null;
  createdAt: number;
  lastUsedAt: number;
}

export interface PageInfo {
  id: string; // pg_... (Browser-OS id; maps internally to a CDP targetId)
  sessionId: string;
  url: string;
  title: string;
  openerPageId: string | null;
}

export interface FrameInfo {
  id: string; // "f0" main frame, "f1".. in document order, stable per observation
  parentId: string | null;
  url: string;
  name: string | null;
  outOfProcess: boolean; // OOPIF -> needs its own CDP session
}
