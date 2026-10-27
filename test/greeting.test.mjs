import {test} from 'node:test';
import assert from 'node:assert/strict';
import {trimGreeting} from '../greeting.mjs';
test('trims fixture text',()=>assert.equal(trimGreeting('  hello  '),'hello'));
