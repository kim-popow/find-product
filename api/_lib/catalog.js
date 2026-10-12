'use strict';

// Single source of truth: the very same catalog the React app renders.
const { productData } = require('../../src/data/productData');

const validNames = new Set(
  Object.values(productData.products)
    .map((product) => product && product.name)
    .filter((name) => typeof name === 'string' && name.length > 0)
);

/** Exact-match check against the names of the products in the catalog. */
function isCatalogProductName(name) {
  return typeof name === 'string' && validNames.has(name);
}

module.exports = { isCatalogProductName };
