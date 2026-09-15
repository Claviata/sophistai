import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beginConversationTurn,
  endConversationTurn,
  isConversationBusy,
} from '../server/locks.js';

test('conversation turn lock is exclusive until released', () => {
  assert.equal(beginConversationTurn(9), true);
  assert.equal(isConversationBusy(9), true);
  assert.equal(beginConversationTurn(9), false);
  endConversationTurn(9);
  assert.equal(isConversationBusy(9), false);
  assert.equal(beginConversationTurn(9), true);
  endConversationTurn(9);
});
