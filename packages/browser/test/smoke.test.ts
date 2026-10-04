import * as self from '@browser-os/browser';
import { expect, it } from 'vitest';

it('package entrypoint resolves through the exports map', () => {
  expect(self).toBeTypeOf('object');
});
