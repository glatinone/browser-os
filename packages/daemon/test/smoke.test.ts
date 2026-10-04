import * as self from '@browser-os/daemon';
import { expect, it } from 'vitest';

it('package entrypoint resolves through the exports map', () => {
  expect(self).toBeTypeOf('object');
});
