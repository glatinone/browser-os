import type { ResolvedTarget, BrowserAction, ValueSource } from '@browser-os/protocol';
import type { PageDriver } from '@browser-os/browser';
import { BosError } from '../errors.js';

export async function verifyAction(
  driver: any,
  action: any,
  resolved: any,
  value: string
): Promise<void> {
  if (action.type === 'fill') {
    const actual = await driver.readValue(resolved);
    if (actual !== value) {
      throw new Error(`VERIFICATION_FAILED: fill value mismatch`);
    }
  } else if (action.type === 'select') {
    // Verify selected option
  } else if (action.type === 'navigate') {
    const result = await driver.readValue({ backendNodeId: 0, cdpFrameId: '', locator: {} });
    if (!result) throw new Error('VERIFICATION_FAILED: navigation failed');
  }
  // click, press, hover, scroll, waitFor - success means no driver error
}

export async function settle(
  driver: any,
  ctx: any,
  constants: any = { settleQuietMs: 100, settleMaxMs: 2000 }
): Promise<{ waitedMs: number; capped: boolean }> {
  const start = Date.now();
  let waitedMs = 0;
  let capped = false;
  
  while (Date.now() - start < constants.settleMaxMs) {
    const mutations = await driver.mutationCounter();
    const network = await driver.networkIdle();
    
    if (mutations === 0 && network) {
      break;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  
  waitedMs = Date.now() - start;
  capped = waitedMs >= constants.settleMaxMs;
  
  return { waitedMs, capped };
}