export {
  PRODUCT_SUPPORT_RUNTIME_VERSION,
  productSearchInputSchema,
  productSearchOutputSchema,
} from './contracts.js';
export type { ProductSearchHandler, ProductSearchInput, ProductSearchOutput } from './contracts.js';
export { createProductSearchHandler } from './search-handler.js';
export type { CreateProductSearchHandlerOptions } from './search-handler.js';
export {
  PRODUCT_SUPPORT_SKILL_DESCRIPTION,
  PRODUCT_SUPPORT_SKILL_ID,
  PRODUCT_SUPPORT_SKILL_INSTRUCTIONS,
  PRODUCT_SUPPORT_SKILL_VERSION,
} from './skill.js';
