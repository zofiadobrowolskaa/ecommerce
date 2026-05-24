import axios from 'axios';

// single axios instance used by all api service modules
// baseURL comes from .env (VITE_API_URL), falls back to localhost for local dev
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3000',
  headers: { 'Content-Type': 'application/json' },
});

// log every api error centrally without swallowing the rejection
api.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error('api error:', error.response?.data || error.message);
    return Promise.reject(error);
  }
);

export default api;
