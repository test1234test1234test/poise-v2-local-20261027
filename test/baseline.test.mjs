import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseline } from '../lib.mjs';
test('baseline', () => assert.equal(baseline(), 'sandbox'));
