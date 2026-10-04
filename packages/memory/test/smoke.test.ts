import * as self from '@browser-os/memory';
import { expect, it } from 'vitest';

it('package entrypoint resolves through the exports map', () => {
  expect(self).toBeTypeOf('object');
});
