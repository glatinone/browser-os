// The shared vocabulary. Every type here is imported by at least one other package,
// so this file (and the modules it re-exports) is the contract surface of Browser-OS.
// Changing a type in here requires an ADR (CODING_AGENT rule 11).

export * from './actions.js';
export * from './browser.js';
export * from './context.js';
export * from './dom.js';
export * from './errors.js';
export * from './events.js';
export * from './ids.js';
export * from './model.js';
export * from './policy.js';
export * from './tasks.js';
