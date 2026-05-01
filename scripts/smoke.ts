#!/usr/bin/env -S bun run
// End-to-end smoke test: drive the MCP server over stdio, exercise every tool
// against a real-but-disposable reminder. Cleans up after itself.
//
// Run: bun run scripts/smoke.ts
//
// Exits 0 on success, 1 on any failure.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const serverPath = resolve(here, "..", "index.ts");

const TEST_LIST = "Health"; // borrow an existing list; we add+remove a sentinel item
const SENTINEL = "_APPLE_REMINDERS_MCP_SMOKE_TEST";
const RENAMED = SENTINEL + "_renamed";

type RpcResp = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};

class Client {
  private proc = spawn("bun", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  private buf = "";
  private waiters = new Map<number, (r: RpcResp) => void>();
  private nextId = 1;

  constructor() {
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as RpcResp;
          if (typeof msg.id === "number" && this.waiters.has(msg.id)) {
            this.waiters.get(msg.id)!(msg);
            this.waiters.delete(msg.id);
          }
        } catch {
          process.stderr.write(`[server] non-JSON line: ${line}\n`);
        }
      }
    });
    this.proc.stderr!.on("data", (d) =>
      process.stderr.write(`[server stderr] ${d}`),
    );
  }

  notify(method: string, params?: unknown) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.proc.stdin!.write(msg);
  }

  request(method: string, params?: unknown): Promise<RpcResp> {
    const id = this.nextId++;
    return new Promise((resolveP, reject) => {
      this.waiters.set(id, resolveP);
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.proc.stdin!.write(msg);
      setTimeout(() => {
        if (this.waiters.has(id)) {
          this.waiters.delete(id);
          reject(new Error(`timeout waiting for ${method}#${id}`));
        }
      }, 30_000);
    });
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const r = await this.request("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`${name} error: ${r.error.message}`);
    return r.result;
  }

  close() {
    this.proc.stdin!.end();
    this.proc.kill();
  }
}

function extractText(result: unknown): string {
  // result.content[0].text
  // biome-ignore lint/suspicious/noExplicitAny: MCP result shape.
  const r = result as any;
  return r?.content?.[0]?.text ?? "";
}

async function main() {
  const c = new Client();
  let pass = 0;
  let fail = 0;
  const log = (label: string, ok: boolean, detail?: string) => {
    const mark = ok ? "✓" : "✗";
    process.stdout.write(`${mark} ${label}${detail ? "  — " + detail : ""}\n`);
    if (ok) pass++;
    else fail++;
  };

  try {
    // 0. Init
    const init = await c.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    });
    log("initialize", !!init.result, JSON.stringify((init.result as any)?.serverInfo));
    c.notify("notifications/initialized");

    // 1. tools/list
    const tl = (await c.request("tools/list")).result as any;
    log("tools/list", Array.isArray(tl?.tools) && tl.tools.length === 9, `${tl?.tools?.length} tools`);

    // 2. list_lists — must include TEST_LIST
    const lists = JSON.parse(extractText(await c.call("list_lists"))) as string[];
    log("list_lists", lists.includes(TEST_LIST), `${lists.length} lists; includes "${TEST_LIST}"=${lists.includes(TEST_LIST)}`);

    // 3. add — creates the sentinel
    const addText = extractText(
      await c.call("add", {
        list: TEST_LIST,
        text: SENTINEL,
        notes: "smoke-test note",
        priority: "low",
        dueDate: "2026-12-31T09:00:00Z",
      }),
    );
    let added: any;
    try { added = JSON.parse(addText); } catch { added = null; }
    const externalId = added?.externalId ?? added?.[0]?.externalId;
    log("add", !!externalId, externalId);

    if (!externalId) throw new Error("add did not return externalId — aborting");

    // 4. show — sentinel must appear
    const showItems = JSON.parse(extractText(await c.call("show", { list: TEST_LIST }))) as any[];
    const found = showItems.find((r) => r.externalId === externalId);
    log("show", !!found, found?.title);

    // 5. show_all — sentinel must appear
    const allItems = JSON.parse(extractText(await c.call("show_all"))) as any[];
    const foundAll = allItems.find((r) => r.externalId === externalId);
    log("show_all", !!foundAll, `total=${allItems.length}`);

    // 6. edit
    await c.call("edit", { list: TEST_LIST, index: externalId, title: RENAMED });
    const afterEdit = JSON.parse(extractText(await c.call("show", { list: TEST_LIST }))) as any[];
    const renamed = afterEdit.find((r) => r.externalId === externalId);
    log("edit", renamed?.title === RENAMED, renamed?.title);

    // 7. complete
    await c.call("complete", { list: TEST_LIST, index: externalId });
    const afterComplete = JSON.parse(
      extractText(await c.call("show", { list: TEST_LIST, includeCompleted: true })),
    ) as any[];
    const completed = afterComplete.find((r) => r.externalId === externalId);
    log("complete", completed?.isCompleted === true, `isCompleted=${completed?.isCompleted}`);

    // 8. uncomplete
    await c.call("uncomplete", { list: TEST_LIST, index: externalId });
    const afterUncomplete = JSON.parse(
      extractText(await c.call("show", { list: TEST_LIST })),
    ) as any[];
    const reopened = afterUncomplete.find((r) => r.externalId === externalId);
    log("uncomplete", reopened?.isCompleted === false, `isCompleted=${reopened?.isCompleted}`);

    // 9. delete (cleanup)
    await c.call("delete", { list: TEST_LIST, index: externalId });
    const afterDelete = JSON.parse(
      extractText(await c.call("show", { list: TEST_LIST, includeCompleted: true })),
    ) as any[];
    const stillThere = afterDelete.find((r) => r.externalId === externalId);
    log("delete", !stillThere, stillThere ? "STILL PRESENT" : "gone");

    // new_list intentionally skipped — reminders-cli has no delete-list command,
    // so testing it would leave cruft on the user's machine.
  } catch (err) {
    log("FATAL", false, err instanceof Error ? err.message : String(err));
  } finally {
    c.close();
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(String(e));
  process.exit(1);
});
