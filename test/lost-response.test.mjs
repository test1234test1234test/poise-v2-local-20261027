import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixtureValue} from '../conflict.mjs';
test('lost-response artifact',()=>assert.equal(fixtureValue,'A'));
