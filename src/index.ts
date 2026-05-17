#!/usr/bin/env node
/**
 * vergabe-mcp — MCP server for German / EU public-procurement data
 *
 * Exposes four tools over stdio:
 *   - vergabe_search_notices       (BKMS + TED unified search)
 *   - vergabe_get_notice_detail    (full notice with PDF text extract)
 *   - vergabe_list_buyer_history   (historical notices per Vergabestelle)
 *   - vergabe_download_documents   (STUB in v1.0 — full impl in v2.0)
 *
 * All logging goes to stderr because stdout is the MCP wire protocol.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  runSearchNotices,
  searchNoticesToolDefinition,
} from "./tools/search_notices.js";
import {
  runGetNoticeDetail,
  getNoticeDetailToolDefinition,
} from "./tools/get_notice_detail.js";
import {
  runListBuyerHistory,
  listBuyerHistoryToolDefinition,
} from "./tools/list_buyer_history.js";
import {
  runDownloadDocuments,
  downloadDocumentsToolDefinition,
} from "./tools/download_documents.js";

const SERVER_NAME = "vergabe-mcp";
const SERVER_VERSION = "1.0.0";

const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      searchNoticesToolDefinition,
      getNoticeDetailToolDefinition,
      listBuyerHistoryToolDefinition,
      downloadDocumentsToolDefinition,
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    let result: unknown;
    switch (name) {
      case "vergabe_search_notices":
        result = await runSearchNotices(args ?? {});
        break;
      case "vergabe_get_notice_detail":
        result = await runGetNoticeDetail(args ?? {});
        break;
      case "vergabe_list_buyer_history":
        result = await runListBuyerHistory(args ?? {});
        break;
      case "vergabe_download_documents":
        result = await runDownloadDocuments(args ?? {});
        break;
      default:
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}`,
            },
          ],
        };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    const message =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[${SERVER_NAME}] tool ${name} failed: ${message}`);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Tool ${name} failed: ${message}`,
        },
      ],
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[${SERVER_NAME}] v${SERVER_VERSION} ready on stdio (tools: vergabe_search_notices, vergabe_get_notice_detail, vergabe_list_buyer_history, vergabe_download_documents)`
  );
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] fatal:`, err);
  process.exit(1);
});
