import React, { useMemo, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { confirmDialog } from '../components/ConfirmDialog';
import usePagination from '../hooks/usePagination';
import Pagination from '../components/Pagination';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import '../styles/pages/_adminDashboard.scss';
import '../styles/pages/_profilePage.scss';
import toast from 'react-hot-toast';

const DashboardPage = () => {
  const { orders, products, removeOrder } = useAppContext();
  
  const [dateRange, setDateRange] = useState('7days');
  const [customDateRange, setCustomDateRange] = useState({ 
    start: new Date().toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0]
  });

  // filter orders based on selected date range
  const filteredOrders = useMemo(() => {
    if (dateRange === 'all') return orders;

    const now = new Date();
    let startDate = new Date();
    let endDate = new Date();

    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);

    switch (dateRange) {
        case 'today':
            break;
        case '7days':
            startDate.setDate(now.getDate() - 7);
            break;
        case '30days':
            startDate.setDate(now.getDate() - 30);
            break;
        case 'thisMonth':
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            startDate.setHours(0, 0, 0, 0);
            break;
        case 'custom':
            if (customDateRange.start) {
                startDate = new Date(customDateRange.start);
                startDate.setHours(0, 0, 0, 0);
            }
            if (customDateRange.end) {
                endDate = new Date(customDateRange.end);
                endDate.setHours(23, 59, 59, 999);
            }
            break;
        default:
            break;
    }

    return orders.filter(order => {
      const orderDate = new Date(order.date);
      return orderDate >= startDate && orderDate <= endDate;
    });
  }, [orders, dateRange, customDateRange]);

  const pagination = usePagination(filteredOrders, 15, { paramName: 'dashboardPage' });

  // aggregate sales by category for chart
  const salesByCategoryData = useMemo(() => {
    const dataMap = {};
    const productMap = products.reduce((map, p) => ({ ...map, [p.id]: p }), {});
    
    const categoryDict = {
        1: "Rings",
        2: "Earrings",
        3: "Necklaces",
        4: "Bracelets"
    };

    filteredOrders.forEach(order => {
      order.items.forEach(item => {
        const product = productMap[item.productId];
        if (product) {
          const catId = product.category_id;
          const categoryName = categoryDict[catId] || product.category || 'Other';
          
          dataMap[categoryName] = (dataMap[categoryName] || 0) + item.quantity;
        }
      });
    });

    return Object.keys(dataMap).map(category => ({
      name: category,
      Sold: dataMap[category],
    }));
  }, [filteredOrders, products]);

  // aggregate revenue over time for chart
  const revenueData = useMemo(() => {
    const dailyRevenue = {};
    filteredOrders.forEach(order => {
        const dateObj = new Date(order.date);
        const dateKey = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        dailyRevenue[dateKey] = (dailyRevenue[dateKey] || 0) + order.total;
    });

    let chartData = Object.keys(dailyRevenue).map(key => {
        return { name: key, Revenue: parseFloat(dailyRevenue[key].toFixed(2)) };
    });

    // limit chart to last 30 days
    if (chartData.length > 30) {
        chartData = chartData.slice(-30);
    }
    
    return chartData;
  }, [filteredOrders]);

  // total product variants
  const totalVariants = useMemo(() => {
    return products.reduce((sum, p) => sum + (p.variants?.length || 0), 0);
  }, [products]);

  // total revenue for selected date range
  const totalRevenue = useMemo(
    () => filteredOrders.reduce((sum, o) => sum + o.total, 0),
    [filteredOrders]
  );

  const handleRemoveOrder = async (orderId) => {
    const confirmed = await confirmDialog.show(
      'Delete Order',
      `Do you want to remove order #${orderId}?`
    );
    if (confirmed) {
        removeOrder(orderId);
        toast.success("Order removed successfully");
    }
  };

  // update custom date range
  const handleCustomDateChange = (e) => {
      setCustomDateRange(prev => ({
          ...prev,
          [e.target.name]: e.target.value
      }));
      pagination.goToPage(1);
  };

  return (
    <div className="admin-dashboard">
      <header className="dashboard-header">
        <div>
            <h1>Administrator Dashboard</h1>
            <p className="subtitle">Overview of your store's performance</p>
        </div>

        <div className="date-filter">
            <div className="filter-controls">
                <div className="filter-buttons">
                {[
                    { id: 'today', label: 'Today' },
                    { id: '7days', label: 'Last 7 Days' },
                    { id: '30days', label: 'Last 30 Days' },
                    { id: 'thisMonth', label: 'This Month' },
                    { id: 'all', label: 'All Time' },
                    { id: 'custom', label: 'Custom' }
                ].map(filter => (
                    <button 
                        key={filter.id}
                        className={dateRange === filter.id ? 'active' : ''} 
                        onClick={() => {
                            setDateRange(filter.id);
                            pagination.goToPage(1);
                        }}
                    >
                    {filter.label}
                    </button>
                ))}
                </div>

                {dateRange === 'custom' && (
                    <div className="custom-date-inputs">
                        <div className="input-group">
                            <label>From:</label>
                            <input 
                                type="date" 
                                name="start"
                                value={customDateRange.start} 
                                onChange={handleCustomDateChange}
                            />
                        </div>
                        <div className="input-group">
                            <label>To:</label>
                            <input 
                                type="date" 
                                name="end"
                                value={customDateRange.end} 
                                onChange={handleCustomDateChange}
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
      </header>

      <div className="stats-grid">
        <div className="stat-card total-orders">
          <div className="stat-content">
              <h3>Total Orders</h3>
              <p>{filteredOrders.length}</p>
          </div>
        </div>
        <div className="stat-card total-revenue">
          <div className="stat-content">
              <h3>Revenue</h3>
              <p>${totalRevenue.toFixed(2)}</p>
          </div>
        </div>
        <div className="stat-card total-products">
          <div className="stat-content">
              <h3>Active Products</h3>
              <p>{totalVariants}</p>
          </div>
        </div>
      </div>

      <div className="charts-container">
        <div className="chart-card">
          <h2>Sales by Category (Units)</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={salesByCategoryData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
              <XAxis dataKey="name" axisLine={false} tickLine={false} />
              <YAxis axisLine={false} tickLine={false} />
              <Tooltip cursor={{fill: '#f9f9f9'}} />
              <Legend />
              <Bar dataKey="Sold" fill="#A08060" name="Units Sold" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-card">
          <h2>Revenue Over Time</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={revenueData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
              <XAxis dataKey="name" axisLine={false} tickLine={false} />
              <YAxis axisLine={false} tickLine={false} />
              <Tooltip formatter={(value) => `$${value}`} cursor={{fill: '#f9f9f9'}} />
              <Legend />
              <Bar dataKey="Revenue" fill="#333" name="Revenue ($)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <section className="order-history">
        <h2>Order History ({filteredOrders.length})</h2>
        {filteredOrders.length === 0 ? (
          <div className="no-data-message">
            No orders found for the selected date range.
          </div>
        ) : (
          <>
            <div className="orders-list">
              <div className="order-item header">
                <span className="order-id">ID</span>
                <span className="customer-email">Customer</span>
                <span className="order-date">Date</span>
                <span className="order-total">Total</span>
                <span className="order-status">Status</span>
                <span className="order-actions">Actions</span>
              </div>
              
              {pagination.paginatedItems.map(order => (
                <div key={order.id} className="order-item">
                  <span className="order-id" data-label="ID">#ORD-{String(order.id).padStart(4, '0')}</span>
                  <span className="customer-email" data-label="Customer">{order.details?.email}</span>
                  <span className="order-date" data-label="Date">
                      {new Date(order.date).toLocaleDateString()}
                  </span>
                  <span className="order-total" data-label="Total"><strong>${order.total.toFixed(2)}</strong></span>
                  <span className={`order-status status-${order.status.toLowerCase()}`} data-label="Status">{order.status}</span>
                  <div className="order-actions" data-label="">
                    <button className="btn-remove-order" onClick={() => handleRemoveOrder(order.id)}>Remove</button>
                  </div>
                </div>
              ))}
            </div>
            
            {pagination.totalPages > 1 && (
              <Pagination
                currentPage={pagination.currentPage}
                totalPages={pagination.totalPages}
                onPageChange={pagination.goToPage}
                itemsPerPage={pagination.itemsPerPage}
                totalItems={pagination.totalItems}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
};

export default DashboardPage;
