import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAppContext } from '../context/AppContext';

/*
  displays order confirmation after successful checkout.
  shows a unique order ID and total for visual feedback.
*/

const OrderConfirmationPage = () => {
    // get the order ID from the URL parameters (defined in route: /order-confirmation/:id)
    const { id } = useParams();

    // retrieve all orders from global context to access stored order data
    const { orders } = useAppContext();
    
    // use == instead of === because backend returns numeric id but URL param is always a string
    const order = orders.find(o => o.id == id);

    if (!order) {
        return (
            <div className="confirmation-page">
                <h1>Order not found.</h1>
                <Link to="/">Return to home page</Link>
            </div>
        );
    }

    return (
        <div className="confirmation-page">
            <h1>Thank you for your order!</h1>
            
            {/* display order id in the same format used across dashboard and profile pages */}
            <p>Order ID: <strong>#ORD-{String(order.id).padStart(4, '0')}</strong></p>
            
            <p>Total: <strong>${order.total.toFixed(2)}</strong></p>
            
            <Link to="/account" className="to-order-page">
                Go to User's Account
            </Link>
        </div>
    );
};

export default OrderConfirmationPage;
