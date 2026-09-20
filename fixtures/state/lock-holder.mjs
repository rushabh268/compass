import { DatabaseSync } from "node:sqlite";

import { openLedger } from "../../src/state/ledger.mjs";

const [path, body, keyHex, delayText] = process.argv.slice(2);
const event = JSON.parse(body);
const ledger = openLedger({ path, hmacKey: Buffer.from(keyHex, "hex") });
const receipt = ledger.append(event);
ledger.close();

const db = new DatabaseSync(path);

db.exec("BEGIN IMMEDIATE");
process.send?.({ status: "locked", receipt });

setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, Number(delayText));
