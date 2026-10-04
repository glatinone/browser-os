import * as self from '@browser-os/dom';
import { expect, it } from 'vitest';

it('package entrypoint resolves through the exports map', () => {
  expect(self).toBeTypeOf('object');
});
