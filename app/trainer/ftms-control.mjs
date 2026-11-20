// Serializes FTMS procedures through their result indications, including disconnect and mode changes.
const RESPONSE_TIMEOUT_MS = 2000; // BLE procedure safety timeout, matching target-power handling.
const RESULT_TEXT = { 1: "Success", 2: "Op code not supported", 3: "Invalid parameter", 4: "Operation failed", 5: "Control not permitted" };

export class FtmsControl {
  constructor(characteristic, onResult) {
    this.characteristic = characteristic;
    this.onResult = onResult;
    this.queue = Promise.resolve();
    this.pending = null;
    this.receivesResponses = false;
    this.listener = (event) => this.handleResponse(event);
  }

  async subscribe() {
    try {
      this.characteristic.addEventListener("characteristicvaluechanged", this.listener);
      await this.characteristic.startNotifications();
      this.receivesResponses = true;
    } catch (error) {
      console.warn("Control point responses are not available.", error);
    }
    return this.receivesResponses;
  }

  reset() {
    this.pending?.reject(new Error("Trainer disconnected."));
    this.characteristic?.removeEventListener("characteristicvaluechanged", this.listener);
    this.characteristic = null;
  }

  handleResponse(event) {
    if (event.target !== this.characteristic) return;
    const data = event.target.value;
    if (data.byteLength < 3 || data.getUint8(0) !== 0x80) return;
    const opcode = data.getUint8(1);
    const result = data.getUint8(2);
    const text = RESULT_TEXT[result] ?? `Error ${result}`;
    console.debug(`[trainer] response: 0x${opcode.toString(16)} -> ${text}`);
    if (this.pending?.opcode === opcode) {
      if (result === 1) this.pending.resolve();
      else this.pending.reject(new Error(text));
    }
    this.onResult(opcode, result, text);
  }

  send(bytes, isCurrent = () => true) {
    const characteristic = this.characteristic;
    const operation = this.queue.then(async () => {
      if (!characteristic || characteristic !== this.characteristic) throw new Error("Trainer connection changed.");
      if (!isCurrent()) return false;
      let timeout;
      let pending;
      const response = this.receivesResponses ? new Promise((resolve, reject) => {
        pending = { opcode: bytes[0], resolve, reject };
        this.pending = pending;
        timeout = setTimeout(() => reject(new Error("No control point response from the trainer.")), RESPONSE_TIMEOUT_MS);
      }) : Promise.resolve();
      const write = this.write(characteristic, bytes).catch((error) => {
        pending?.reject(error);
        throw error;
      });
      try {
        const results = await Promise.allSettled([write, response]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
        return true;
      } finally {
        clearTimeout(timeout);
        if (this.pending === pending) this.pending = null;
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async write(characteristic, bytes) {
    // FTMS requires Write Request; use the legacy fallback only when that
    // method is absent, not after an ambiguous failed write.
    if (characteristic.properties?.write === false && characteristic.properties?.writeWithoutResponse) {
      await characteristic.writeValueWithoutResponse(new Uint8Array(bytes));
    } else if (typeof characteristic.writeValueWithResponse === "function") {
      await characteristic.writeValueWithResponse(new Uint8Array(bytes));
    } else if (typeof characteristic.writeValue === "function") {
      await characteristic.writeValue(new Uint8Array(bytes));
    } else {
      await characteristic.writeValueWithoutResponse(new Uint8Array(bytes));
    }
  }
}
