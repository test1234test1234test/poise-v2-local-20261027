import {test} from 'node:test';
import assert from 'node:assert/strict';
import {concurrentValue} from '../conflict.mjs';
test('concurrent artifact',()=>assert.equal(concurrentValue,'B'));
