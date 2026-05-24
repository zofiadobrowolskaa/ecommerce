import React, { createContext, useContext, useMemo, useState, useEffect, useCallback } from 'react';
import useLocalStorage from '../hooks/useLocalStorage';
import { authService } from '../auth/authService';
import * as cartApi from '../api/cart';
import * as ordersApi from '../api/orders';
import * as productsApi from '../api/products';

export const AppContext = createContext();

// helper to calculate total value of items in the cart
const calculateCartTotal = (currentCart, products) => {
  return currentCart.reduce((total, item) => {
    // safely match string or number IDs using ==
    const product = products.find(p => p.id == item.productId);
    if (!product) return total;

    // safe check for variants using optional chaining
    const variant = product.variants?.find(v => v.id === item.variantId);

    // force numerical types to prevent string concatenation bugs
    const basePrice = Number(product.price) || 0;
    const adjustment = variant ? Number(variant.priceAdjustment) : 0;

    return total + ((basePrice + adjustment) * item.quantity);
  }, 0);
};

const defaultProfile = {
  name: '', surname: '', email: '', phone: '',
  address: '', house_number: '', flat_number: '',
  postalCode: '', city: '', country: '',
};

export const AppProvider = ({ children }) => {
  // products fetched from the backend on mount
  const [products, setProducts] = useState([]);

  // server-synced cart state
  const [cart, setCart] = useState([]);

  const [userRole, setUserRole] = useLocalStorage('userRole', 'client');
  const [discount, setDiscount] = useLocalStorage('discount', { code: '', percentage: 0 });

  // orders saved locally for the dashboard after each successful checkout
  const [orders, setOrders] = useLocalStorage('orders', []);

  const [user, setUser] = useState(null);
  const [profile, setProfileState] = useState(defaultProfile);

  // returns the authenticated userId or a persistent guest uuid stored in localStorage
  const getUserId = useCallback(() => {
    if (user?.userId) return user.userId;
    let guestId = localStorage.getItem('guestUserId');
    if (!guestId) {
      // crypto.randomUUID is available in all modern browsers
      guestId = `guest-${crypto.randomUUID()}`;
      localStorage.setItem('guestUserId', guestId);
    }
    return guestId;
  }, [user]);

  // fetch all products from the api gateway on mount
  useEffect(() => {
    const fetchGlobalProducts = async () => {
      try {
        const response = await productsApi.getProducts();
        setProducts(response.data);
      } catch (error) {
        console.error('failed to fetch products for context', error);
      }
    };
    fetchGlobalProducts();
  }, []);

  // initialize authentication state from the stored token
  useEffect(() => {
    const initAuth = () => {
      const currentUser = authService.getCurrentUser();
      if (currentUser) {
        setUser(currentUser);
        setProfileState({
          name: currentUser.name || '',
          surname: currentUser.surname || '',
          email: currentUser.email || '',
          phone: currentUser.phone || '',
          address: currentUser.address || '',
          house_number: currentUser.house_number || '',
          flat_number: currentUser.flat_number || '',
          postalCode: currentUser.postalCode || '',
          city: currentUser.city || '',
          country: currentUser.country || '',
        });
      }
    };
    initAuth();
  }, []);

  const isAdmin = userRole === 'admin';
  const loginAs = (role) => {
    if (role === 'admin' || role === 'client') setUserRole(role);
  };

  const cartTotal = useMemo(() => calculateCartTotal(cart, products), [cart, products]);
  const discountValue = useMemo(() => cartTotal * discount.percentage, [cartTotal, discount]);

  // build the items payload expected by the backend from the current cart
  const buildCartItems = useCallback((cartItems) => {
    return cartItems.map(item => {
      const product = products.find(p => p.id == item.productId);
      const variant = product?.variants?.find(v => v.id === item.variantId);
      // sum base price and variant adjustment for each line
      const price = (Number(product?.price) || 0) + (Number(variant?.priceAdjustment) || 0);
      return { productId: item.productId, quantity: item.quantity, price };
    });
  }, [products]);

  // update local cart state then push the full state to the server
  const syncCartWithServer = useCallback(async (newCart) => {
    // update UI immediately (optimistic update)
    setCart(newCart);
    try {
      const items = buildCartItems(newCart);
      const userId = getUserId();
      await cartApi.syncCart(userId, items);
    } catch (error) {
      console.error('failed to sync cart with server', error);
    }
  }, [buildCartItems, getUserId]);

  // add a product variant to the cart, merging quantity if already present
  const addToCart = useCallback((productId, variantId, quantity = 1, size = null) => {
    const idx = cart.findIndex(
      item => item.productId === productId && item.variantId === variantId && item.size === size
    );
    let newCart;
    if (idx > -1) {
      newCart = [...cart];
      newCart[idx].quantity += quantity;
    } else {
      newCart = [...cart, { productId, variantId, quantity, size }];
    }
    syncCartWithServer(newCart);
  }, [cart, syncCartWithServer]);

  const removeFromCart = useCallback((productId, variantId, size = null) => {
    const newCart = cart.filter(
      item => !(item.productId === productId && item.variantId === variantId && item.size === size)
    );
    syncCartWithServer(newCart);
  }, [cart, syncCartWithServer]);

  const updateQuantity = useCallback((productId, variantId, newQuantity, size = null) => {
    if (newQuantity <= 0) return removeFromCart(productId, variantId, size);
    const newCart = cart.map(item =>
      (item.productId === productId && item.variantId === variantId && item.size === size)
        ? { ...item, quantity: newQuantity }
        : item
    );
    syncCartWithServer(newCart);
  }, [cart, removeFromCart, syncCartWithServer]);

  const applyDiscount = useCallback((code) => {
    if (code === 'AURA20') {
      setDiscount({ code: 'AURA20', percentage: 0.20 });
      return true;
    }
    return false;
  }, [setDiscount]);

  const resetDiscount = useCallback(() => setDiscount({ code: '', percentage: 0 }), [setDiscount]);

  // send checkout to the real backend, then save the order locally for the dashboard
  const placeOrder = useCallback(async (orderData) => {
    const userId = getUserId();
    const items = buildCartItems(cart);

    // throws on network error or validation failure — caller must catch
    const response = await ordersApi.checkout(userId, items);
    const { orderId } = response.data;

    // persist order locally so the admin dashboard can display it without extra calls
    const newOrder = {
      id: orderId,
      date: new Date().toISOString(),
      items: cart,
      total: cartTotal - discountValue,
      details: orderData,
      status: 'Completed',
    };
    setOrders(prev => [newOrder, ...prev]);

    // clear the server-side cart after successful checkout
    await syncCartWithServer([]);
    resetDiscount();

    return orderId;
  }, [cart, cartTotal, discountValue, getUserId, buildCartItems, syncCartWithServer, resetDiscount, setOrders]);

  const removeOrder = useCallback((id) => setOrders(prev => prev.filter(o => o.id !== id)), [setOrders]);

  const login = useCallback(async (email, password) => {
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      const userData = authService.login(email, password);
      setUser(userData);
      setProfileState({ ...defaultProfile, ...userData });
      return { success: true };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }, []);

  const register = useCallback(async (email, password, name, surname) => {
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      const userData = authService.register(email, password, name, surname);
      setUser(userData);
      setProfileState({
        ...defaultProfile,
        name: userData.name,
        surname: userData.surname,
        email: userData.email,
      });
      return { success: true };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }, []);

  const logout = useCallback(() => {
    authService.logout();
    setUser(null);
    setProfileState(defaultProfile);
    // clear the server cart tied to this user
    syncCartWithServer([]);
    setDiscount({ code: '', percentage: 0 });
  }, [syncCartWithServer, setDiscount]);

  const updateProfile = useCallback((updatedData) => {
    try {
      setProfileState(prev => ({ ...prev, ...updatedData }));
      if (user) {
        const updatedUser = authService.updateUser(updatedData);
        setUser(updatedUser);
      }
    } catch {
      // profile update failed silently
    }
  }, [user]);

  const addProduct = useCallback((newProduct) => setProducts(prev => [newProduct, ...prev]), []);

  const updateProduct = useCallback((updatedProduct) =>
    setProducts(prev => prev.map(p => p.id === updatedProduct.id ? updatedProduct : p)), []);

  // delete product from the backend then remove it from local state
  const deleteProduct = useCallback(async (id) => {
    await productsApi.deleteProduct(id);
    setProducts(prev => prev.filter(p => p.id !== id));
  }, []);

  const resetAppData = useCallback(() => {
    localStorage.removeItem('orders');
    localStorage.removeItem('discount');
    syncCartWithServer([]);
    window.location.reload();
  }, [syncCartWithServer]);

  const contextValue = {
    products, setProducts,
    cart, addToCart, removeFromCart, updateQuantity, cartTotal,
    discount, applyDiscount, discountValue, cartTotalAfterDiscount: cartTotal - discountValue,
    userRole, loginAs, isAdmin,
    orders, placeOrder, removeOrder,
    login, logout, register, user,
    profile, updateProfile,
    addProduct, updateProduct, deleteProduct,
    resetAppData,
    getUserId,
  };

  return (
    <AppContext.Provider value={contextValue}>
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error('useAppContext must be used within an AppProvider');
  return context;
};
