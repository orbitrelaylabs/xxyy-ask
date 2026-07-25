export {
  PRODUCT_QA_MCP_SEARCH_TOOL_NAME,
  PRODUCT_QA_MCP_SERVER_NAME,
  PRODUCT_QA_MCP_VERSION,
  productSearchInputSchema,
  productSearchOutputSchema,
} from './contracts.js';
export type {
  ProductQaMcpClient,
  ProductSearchHandler,
  ProductSearchInput,
  ProductSearchOutput,
} from './contracts.js';
export {
  ProductQaMcpToolError,
  createInMemoryProductQaMcpClient,
  createProductQaMcpClientStub,
} from './client.js';
export type { CreateInMemoryProductQaMcpClientOptions } from './client.js';
export {
  classifyProductQaMcpError,
  decodeProductQaMcpError,
  encodeProductQaMcpError,
  productQaMcpErrorCodes,
} from './errors.js';
export type { ProductQaMcpErrorCode } from './errors.js';
export { createProductSearchHandler } from './search-handler.js';
export type { CreateProductSearchHandlerOptions } from './search-handler.js';
export { PRODUCT_QA_MCP_INSTRUCTIONS, createProductQaMcpServer } from './server.js';
export type { CreateProductQaMcpServerOptions } from './server.js';
export {
  PRODUCT_SUPPORT_SKILL_DESCRIPTION,
  PRODUCT_SUPPORT_SKILL_ID,
  PRODUCT_SUPPORT_SKILL_INSTRUCTIONS,
  PRODUCT_SUPPORT_SKILL_PROMPT_NAME,
  PRODUCT_SUPPORT_SKILL_RESOURCE_URI,
  PRODUCT_SUPPORT_SKILL_VERSION,
} from './skill.js';
