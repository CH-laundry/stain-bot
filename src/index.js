#!/usr/bin/env node
require('dotenv').config();
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { LaundryAPI } from './laundry-api.js';

// 從環境變數讀取配置
const API_BASE_URL = process.env.LAUNDRY_API_BASE_URL || 'http://lk2.ao-lan.cn';
const AUTH_TOKEN = process.env.LAUNDRY_AUTH_TOKEN;

if (!AUTH_TOKEN) {
  console.error('錯誤: 請設定 LAUNDRY_AUTH_TOKEN 環境變數');
  process.exit(1);
}

// 初始化 API 客戶端
const laundryAPI = new LaundryAPI(API_BASE_URL, AUTH_TOKEN);

// 建立 MCP Server
const server = new Server(
  {
    name: 'ch-laundry-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * 定義可用的工具
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_orders_list',
        description: '查詢收衣訂單列表。可以查詢今日、本週或所有訂單。',
        inputSchema: {
          type: 'object',
          properties: {
            params: {
              type: 'object',
              description: '查詢參數（選填）',
              properties: {
                pageIndex: {
                  type: 'number',
                  description: '頁碼，預設為 0'
                },
                pageSize: {
                  type: 'number',
                  description: '每頁筆數，預設為 20'
                }
              }
            }
          }
        },
      },
      {
        name: 'get_order_detail',
        description: '查詢單一訂單的詳細資料，包含衣物明細、客戶資訊、金額等。',
        inputSchema: {
          type: 'object',
          properties: {
            orderId: {
              type: 'string',
              description: '訂單 ID（例如：10af3c62-0fb7-400c-add6-4d613ba5ef8b）',
            },
          },
          required: ['orderId'],
        },
      },
      {
        name: 'update_delivery_status',
        description: '更新配送訂單狀態為「已簽收」。客戶取件後使用。',
        inputSchema: {
          type: 'object',
          properties: {
            deliverOrderId: {
              type: 'string',
              description: '配送訂單 ID',
            },
          },
          required: ['deliverOrderId'],
        },
      },
      {
        name: 'get_delivery_info',
        description: '查詢配送訂單的詳細資訊。',
        inputSchema: {
          type: 'object',
          properties: {
            deliverOrderId: {
              type: 'string',
              description: '配送訂單 ID',
            },
          },
          required: ['deliverOrderId'],
        },
      },
    ],
  };
});

/**
 * 處理工具調用請求
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_orders_list': {
        const params = args.params || {};
        const result = await laundryAPI.getOrdersList(params);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_order_detail': {
        const { orderId } = args;
        if (!orderId) {
          throw new Error('缺少必要參數: orderId');
        }
        const result = await laundryAPI.getOrderDetail(orderId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'update_delivery_status': {
        const { deliverOrderId } = args;
        if (!deliverOrderId) {
          throw new Error('缺少必要參數: deliverOrderId');
        }
        const result = await laundryAPI.updateDeliveryStatus(deliverOrderId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_delivery_info': {
        const { deliverOrderId } = args;
        if (!deliverOrderId) {
          throw new Error('缺少必要參數: deliverOrderId');
        }
        const result = await laundryAPI.getDeliveryInfo(deliverOrderId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`未知的工具: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `錯誤: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

/**
 * 啟動伺服器
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('C.H 洗衣 MCP Server 已啟動');
}

main().catch((error) => {
  console.error('伺服器啟動失敗:', error);
  process.exit(1);
});
