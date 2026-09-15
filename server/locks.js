const inFlight = new Set();

export function isConversationBusy(id) {
  return inFlight.has(Number(id));
}

export function beginConversationTurn(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || inFlight.has(n)) return false;
  inFlight.add(n);
  return true;
}

export function endConversationTurn(id) {
  inFlight.delete(Number(id));
}
