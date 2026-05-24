import api from './client';

// fetch all products; params object is forwarded as query string (e.g. category, price)
export const getProducts = (params) => api.get('/api/products', { params });

// fetch a single product by numeric id or sku string
export const getProductById = (id) => api.get(`/api/products/${id}`);

// fetch the list of available product categories
export const getCategories = () => api.get('/api/categories');

// create a new product through the hybrid saga (postgres + mongodb)
export const createProduct = (data) => api.post('/api/products', data);

// delete a product from both databases by its numeric id
export const deleteProduct = (id) => api.delete(`/api/products/${id}`);
