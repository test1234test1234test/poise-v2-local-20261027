import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixtureValue} from '../conflict.mjs';
test('concurrent artifact',()=>assert.equal(fixtureValue,'B'));
