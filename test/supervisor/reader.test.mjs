import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSupervisor } from "../../src/supervisor/server.mjs";
import { request } from "../../src/supervisor/client.mjs";
test("reader credential permits only reads before replay lookup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "compass-reader-"));
  const authKey = Buffer.alloc(32, 1),
    readerKey = Buffer.alloc(32, 2);
  let mutations = 0;
  const server = await startSupervisor({
    socketPath: join(root, "rpc"),
    authKey,
    readerKey,
    ledger: {
      createRun() {
        mutations++;
        return { created: true };
      },
    },
  });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = (key, method, params = {}, id = method) =>
    request({
      socketPath: join(root, "rpc"),
      authKey: key,
      method,
      params,
      id,
    });
  assert.equal((await call(readerKey, "health")).ok, true);
  await call(authKey, "createRun", { runID: "synthetic" }, "reused");
  for (const method of [
    "createRun",
    "append",
    "prune",
    "verifyAll",
    "listEvents",
  ])
    await assert.rejects(
      call(readerKey, method, {}, "reused"),
      /reader method denied/,
    );
  assert.equal(mutations, 1);
});

test('reader key cannot be HMAC-equivalent to writer key through zero padding',async t=>{
 const root=await mkdtemp(join(tmpdir(),'compass-reader-key-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const authKey=Buffer.alloc(32,1),readerKey=Buffer.concat([authKey,Buffer.alloc(1)]);
 let server;
 t.after(async()=>{await server?.close();});
 await assert.rejects(async()=>{server=await startSupervisor({socketPath:join(root,'rpc'),authKey,readerKey,ledger:{}});},/distinct/);
 await server?.close();
});
