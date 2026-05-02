#!/usr/bin/env -S bun run
// mcp-reminders-cli — MCP server wrapping keith/reminders-cli.
//
// Exposes Apple Reminders to Claude (or any MCP client) via stdio. Uses the
// `reminders` binary (https://github.com/keith/reminders-cli) under the hood,
// which calls EventKit directly — so it sees iCloud-synced lists and is fast.
//
// Tools:
//   list_lists            — list every reminder list
//   show <list>           — show items in a list (open by default)
//   show_all              — show items across all lists
//   add  <list> <text>    — create a reminder
//   complete   <list> <index|id>
//   uncomplete <list> <index|id>
//   delete     <list> <index|id>
//   edit       <list> <index|id> [title] [notes]
//   new_list   <name>
//
// Index/id: pass the externalId from a `show` result for stable references
// (item indexes shift as items are added/completed).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function rcli(args: string[]): Promise<string> {
  const { stdout } = await exec("reminders", args, {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function rcliJson(args: string[]): Promise<unknown> {
  const out = await rcli([...args, "--format", "json"]);
  return JSON.parse(out);
}

const tools = [
  {
    name: "list_lists",
    description: "Return every reminder list by name.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "show",
    description:
      "Show items in a specific list. Returns array of {externalId, title, list, isCompleted, priority, dueDate?, notes?}. Open items only by default.",
    inputSchema: {
      type: "object",
      required: ["list"],
      properties: {
        list: { type: "string", description: "List name (see list_lists)." },
        includeCompleted: { type: "boolean" },
        onlyCompleted: { type: "boolean" },
        sort: {
          type: "string",
          enum: ["none", "creation-date", "due-date"],
        },
        sortOrder: {
          type: "string",
          enum: ["ascending", "descending"],
        },
        dueDate: {
          type: "string",
          description: "Filter to reminders due on this date (YYYY-MM-DD or natural language).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "show_all",
    description: "Show items across all lists.",
    inputSchema: {
      type: "object",
      properties: {
        includeCompleted: { type: "boolean" },
        onlyCompleted: { type: "boolean" },
        dueDate: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "add",
    description: "Create a new reminder.",
    inputSchema: {
      type: "object",
      required: ["list", "text"],
      properties: {
        list: { type: "string" },
        text: { type: "string" },
        dueDate: {
          type: "string",
          description: "ISO 8601 timestamp or natural-language date.",
        },
        priority: {
          type: "string",
          description: "Priority. reminders-cli accepts: none, low, medium, high.",
        },
        notes: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "complete",
    description:
      "Mark a reminder complete. Pass the externalId (from show) for a stable reference; the numeric index also works but shifts as items change.",
    inputSchema: {
      type: "object",
      required: ["list", "index"],
      properties: {
        list: { type: "string" },
        index: { type: "string", description: "externalId or numeric index" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "uncomplete",
    description: "Unmark a completed reminder.",
    inputSchema: {
      type: "object",
      required: ["list", "index"],
      properties: {
        list: { type: "string" },
        index: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "delete",
    description: "Delete a reminder.",
    inputSchema: {
      type: "object",
      required: ["list", "index"],
      properties: {
        list: { type: "string" },
        index: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "edit",
    description:
      "Edit a reminder's title and/or notes. Pass either or both — at least one is required. Note: passing `notes` overwrites the previous notes (CLI semantics).",
    inputSchema: {
      type: "object",
      required: ["list", "index"],
      properties: {
        list: { type: "string" },
        index: { type: "string", description: "externalId or numeric index" },
        title: { type: "string", description: "New title. Optional." },
        notes: {
          type: "string",
          description:
            "New notes body. Overwrites existing notes. Optional.",
        },
      },
      anyOf: [{ required: ["title"] }, { required: ["notes"] }],
      additionalProperties: false,
    },
  },
  {
    name: "new_list",
    description: "Create a new reminder list.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: "mcp-reminders-cli", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  // biome-ignore lint/suspicious/noExplicitAny: MCP args are loosely typed at the boundary.
  const a = (rawArgs ?? {}) as any;

  try {
    switch (name) {
      case "list_lists": {
        const out = await rcli(["show-lists"]);
        const names = out
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        return {
          content: [{ type: "text", text: JSON.stringify(names, null, 2) }],
        };
      }
      case "show": {
        const flags: string[] = [];
        if (a.includeCompleted) flags.push("--include-completed");
        if (a.onlyCompleted) flags.push("--only-completed");
        if (a.sort) flags.push("--sort", a.sort);
        if (a.sortOrder) flags.push("--sort-order", a.sortOrder);
        if (a.dueDate) flags.push("--due-date", a.dueDate);
        const data = await rcliJson(["show", a.list, ...flags]);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
      case "show_all": {
        const flags: string[] = [];
        if (a.includeCompleted) flags.push("--include-completed");
        if (a.onlyCompleted) flags.push("--only-completed");
        if (a.dueDate) flags.push("--due-date", a.dueDate);
        const data = await rcliJson(["show-all", ...flags]);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
      case "add": {
        const flags: string[] = [];
        if (a.dueDate) flags.push("--due-date", a.dueDate);
        if (a.priority) flags.push("--priority", a.priority);
        if (a.notes) flags.push("--notes", a.notes);
        const data = await rcliJson(["add", a.list, a.text, ...flags]);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
      case "complete": {
        await rcli(["complete", a.list, String(a.index)]);
        return {
          content: [
            { type: "text", text: `completed: ${a.list} #${a.index}` },
          ],
        };
      }
      case "uncomplete": {
        await rcli(["uncomplete", a.list, String(a.index)]);
        return {
          content: [
            { type: "text", text: `uncompleted: ${a.list} #${a.index}` },
          ],
        };
      }
      case "delete": {
        await rcli(["delete", a.list, String(a.index)]);
        return {
          content: [{ type: "text", text: `deleted: ${a.list} #${a.index}` }],
        };
      }
      case "edit": {
        if (a.title === undefined && a.notes === undefined) {
          throw new Error("edit requires at least one of: title, notes");
        }
        const args = ["edit", a.list, String(a.index)];
        if (a.notes !== undefined) args.push("--notes", a.notes);
        if (a.title !== undefined) args.push(a.title);
        await rcli(args);
        const changed: string[] = [];
        if (a.title !== undefined) changed.push(`title="${a.title}"`);
        if (a.notes !== undefined)
          changed.push(`notes (${a.notes.length} chars)`);
        return {
          content: [
            {
              type: "text",
              text: `edited ${a.list} #${a.index} -> ${changed.join(", ")}`,
            },
          ],
        };
      }
      case "new_list": {
        await rcli(["new-list", a.name]);
        return {
          content: [{ type: "text", text: `created list: ${a.name}` }],
        };
      }
      default:
        return {
          content: [{ type: "text", text: `unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `error: ${msg}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
