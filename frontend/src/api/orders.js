import api from './client';

// submit the cart as a checkout order; backend applies oversell protection
export const checkout = (userId, items) =>
  api.post('/api/checkout', { userId, items });

// fetch all orders placed by a specific user
export const getOrders = (userId) =>
  api.get(`/api/users/${userId}/orders`);

// cancel an order by id and restore its reserved stock
export const cancelOrder = (orderId) =>
  api.post(`/api/orders/${orderId}/cancel`);
