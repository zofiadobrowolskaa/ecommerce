import api from './client';

// replace the server-side cart with the full items array sent from the frontend
export const syncCart = (userId, items) =>
  api.post(`/api/cart/${userId}/sync`, { items });

// fetch the current server-side cart state for a given user
export const getCart = (userId) => api.get(`/api/cart/${userId}`);

// add a single item to the cart with a stock availability check
export const addItem = (userId, item) =>
  api.post(`/api/cart/${userId}/add`, item);
