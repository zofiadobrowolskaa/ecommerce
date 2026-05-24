import React from 'react';
import { Routes, Route, Link, Navigate } from 'react-router-dom';
import CartIcon from '../CartIcon';
import ScrollToTop from '../ScrollToTop';
import '../../styles/pages/_layout.scss';
import HomePage from '../../pages/HomePage';
import ProductListPage from '../../pages/ProductListPage';
import ProductDetailsPage from '../../pages/ProductDetailsPage';
import CartPage from '../../pages/CartPage';
import CheckoutPage from '../../pages/CheckoutPage';
import OrderConfirmationPage from '../../pages/OrderConfirmationPage';
import AccountPage from '../../pages/AccountPage';

const ClientLayout = () => {
  return (
    <div className="client-app-wrapper">
      <header className="client-header">
        <nav className="main-nav">
        {/* client panel navigation */}
          <Link to="/" className="nav-headers">Home</Link>
          <Link to="/products" className="nav-headers">Shop</Link>
          <Link to="/" className="title">AURA</Link>
          <Link to="/account" className="nav-headers">Account</Link>
          <CartIcon />
        </nav>
      </header>

      {/* fires window.scrollTo(0,0) on every route change */}
      <ScrollToTop />

      <main className="client-main">
        {/* client-side routing configuration */}
        <Routes>
            <Route path="/products" element={<ProductListPage />} />
             <Route path="/products/:id/:variantId" element={<ProductDetailsPage />} />
             <Route path="/cart" element={<CartPage />} />
             <Route path="/checkout" element={<CheckoutPage />} />
             <Route path="/order-confirmation/:id" element={<OrderConfirmationPage />} />
             <Route path="/account" element={<AccountPage />} />
             <Route path="/" element={<HomePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <footer className="client-footer">
        © {new Date().getFullYear()} Aura. All rights reserved.
      </footer>
    </div>
  );
};

export default ClientLayout;
