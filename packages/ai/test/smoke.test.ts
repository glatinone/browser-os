import * as self from '@browser-os/ai';
import { expect, it } from 'vitest';

it('package entrypoint resolves through the exports map', () => {
  expect(self).toBeTypeOf('object');
});
