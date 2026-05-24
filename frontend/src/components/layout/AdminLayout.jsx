import React from 'react';
import { Routes, Route, Link, Navigate } from 'react-router-dom';
import DashboardPage from '../../pages/DashboardPage';
import ProductManagementPage from '../../pages/ProductManagementPage';
import ScrollToTop from '../ScrollToTop';
import '../../styles/pages/_layout.scss';

const AdminLayout = () => {
  return (
    <div className="admin-app-wrapper">
      <header className="admin-header">
        <nav className="main-nav">
          {/* admin panel navigation */}
          <Link to="/admin/dashboard" className="nav-headers">Dashboard</Link>
          <Link to="/admin/dashboard" className="title">AURA</Link>
          <Link to="/admin/products" className="nav-headers">
            Product Management
          </Link>
        </nav>
      </header>

      {/* fires window.scrollTo(0,0) on every route change */}
      <ScrollToTop />

      <main className="admin-main">
        {/* admin routing configuration */}
        <Routes>
          <Route path="/admin/dashboard" element={<DashboardPage />} />
          <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
          <Route path="/admin/products" element={<ProductManagementPage />} />
          <Route path="*" element={<Navigate to="/admin/dashboard" replace />} />
        </Routes>
      </main>

      <footer className="admin-footer">Aura Admin Panel</footer>
    </div>
  );
};

export default AdminLayout;
