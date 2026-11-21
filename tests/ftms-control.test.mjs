import test from "node:test";
import assert from "node:assert/strict";
import { FtmsControl } from "../app/trainer/ftms-control.mjs";

function fake() {
  const writes = [];
  const handlers = new Set();
  const characteristic = {
    addEventListener: (_, fn) => handlers.add(fn),
    removeEventListener: (_, fn) => handlers.delete(fn),
    startNotifications: async () => {},
    writeValueWithResponse: async (bytes) => { writes.push([...bytes]); },
  };
  const reply = (opcode, result = 1) => {
    characteristic.value = new DataView(Uint8Array.of(0x80, opcode, result).buffer);
    for (const fn of handlers) fn({ target: characteristic });
  };
  return { writes, reply, control: new FtmsControl(characteristic, () => {}) };
}

test("FTMS waits for procedure success before sending the next command", async () => {
  const { writes, reply, control } = fake();
  await control.subscribe();
  const road = control.send([0x11]);
  const power = control.send([0x05]);
  await new Promise(setImmediate);
  assert.deepEqual(writes, [[0x11]]);
  reply(0x07); // An unrelated indication must not release the queue.
  assert.deepEqual(writes, [[0x11]]);
  reply(0x11);
  await road;
  await new Promise(setImmediate);
  assert.deepEqual(writes, [[0x11], [0x05]]);
  reply(0x05);
  await power;
});

test("FTMS rejects a command even when the ATT write succeeded", async () => {
  const { reply, control } = fake();
  await control.subscribe();
  const sent = control.send([0x11]);
  const rejected = assert.rejects(sent, /Op code not supported/);
  await new Promise(setImmediate);
  reply(0x11, 2);
  await rejected;
});

test("queued terrain commands can be canceled when ERG takes control", async () => {
  const { writes, reply, control } = fake();
  await control.subscribe();
  let allowed = true;
  const first = control.send([0x07]);
  const obsolete = control.send([0x11], () => allowed);
  await new Promise(setImmediate);
  allowed = false;
  reply(0x07);
  await first;
  assert.equal(await obsolete, false);
  assert.deepEqual(writes, [[0x07]]);
});

test("disconnect rejects pending procedures and prevents queued writes", async () => {
  const { writes, control } = fake();
  await control.subscribe();
  const first = assert.rejects(control.send([0x11]), /disconnected/);
  const queued = assert.rejects(control.send([0x05]), /connection changed/);
  await new Promise(setImmediate);
  control.reset();
  await Promise.all([first, queued]);
  assert.equal(writes.length, 1);
});
