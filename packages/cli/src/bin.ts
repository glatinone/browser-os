#!/usr/bin/env node
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { version: { type: 'boolean', short: 'v' } },
});

if (values.version) {
  process.stdout.write('bos 0.0.0\n');
} else {
  process.stdout.write('bos 0.0.0 (scaffold - run with --version)\n');
}
