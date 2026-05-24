import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppContext } from '../../context/AppContext';

const Step4Summary = ({ prevStep, formData, cartTotal, cartItems, shippingCost, discountValue }) => {

  const { placeOrder, products } = useAppContext();
  const navigate = useNavigate();
  
  // local state controlling payment process state machine (idle -> processing -> success/error)
  const [paymentStatus, setPaymentStatus] = useState('idle');
  const [orderId, setOrderId] = useState(null);

  // send the order to the real checkout endpoint and navigate on success
  const handleFinalOrder = async () => {
    // prevent double-submission while a request is in flight
    if (paymentStatus === 'processing') return;

    setPaymentStatus('processing');

    try {
      // placeOrder calls POST /api/checkout and returns the real orderId from the backend
      const newOrderId = await placeOrder(formData);
      setOrderId(newOrderId);
      setPaymentStatus('success');

      // short delay so the user sees the success message before redirect
      setTimeout(() => navigate(`/order-confirmation/${newOrderId}`), 1000);
    } catch (err) {
      // backend returned an error (e.g. out of stock, validation failure)
      console.error('checkout failed', err);
      setPaymentStatus('error');
    }
  };

  const buttonText = {
    idle: 'Place Order and Pay', 
    processing: 'Processing...',  
    success: 'Payment Accepted!',
    error: 'Payment Error. Try again.',
  };

  return (
    <div className="checkout-step summary-step">
      <h2>4. Summary and Finalization</h2>

      {/* display customer and shipping information */}
      <section>
        <h3>Customer and Shipping Data</h3>
        <p>Name: {formData.name}</p>
        <p>Surname: {formData.surname}</p>
        <p>Email: {formData.email}</p>
        {formData.phone && formData.phone.trim() !== "" && (
          <p>Phone: {formData.phone}</p>
        )}
        <p>Address: {formData.address} {formData.house_number}{formData.flat_number ? `/${formData.flat_number},` : ''} {formData.city}, {formData.postalCode}, {formData.country}</p>
        <p>Shipping Method: {formData.shippingMethod === 'standard' ? 'Standard' : 'Express'}</p>
      </section>

      {/* display payment information with masked card number for security */}
      <section>
        <h3>Payment Data</h3>
        <p>Payment Method: {formData.paymentMethod === 'card' ? 'Card' : 'Bank Transfer'}</p>
        {formData.paymentMethod === 'card' && (
          <>
            <p>Card Number: **** **** **** {formData.cardNumber.slice(-4)}</p>
            <p>Expiry Date: {formData.expiryDate}</p>
            <p>CVV: {formData.cvv}</p>
          </>
        )}
      </section>

      {/* aggregate cart items and final costs */}
      <section>
        <h3>Order Total</h3>
        <ul className="cart-items-summary">
          {Array.isArray(cartItems) && cartItems.length > 0 ? (
            cartItems.map(item => {
              // zabezpieczenie: szukamy pelnego produktu i wariantu bezposrednio z backendowego kontekstu
              const product = products?.find(p => String(p.id) === String(item.productId) || p.sku === item.productId);
              const currentVariant = product?.variants?.find(v => v.id === item.variantId) || product?.variants?.[0];
              
              // wybieramy obraz z wariantu, a jak nie ma, to z galerii
              const finalImage = currentVariant?.imageUrl || product?.gallery?.[0] || item.imageUrl || '/img/placeholder.jpg';
              const finalColor = currentVariant?.color || item.variantColor || 'Default';

              return (
                <li key={`${item.productId}-${item.variantId}-${item.itemSize}`} className="cart-summary-item">
                  <img src={finalImage} alt={item.name} className="cart-summary-item-image" />
                  <span className="cart-summary-item-info">
                    {item.name} ({finalColor}) {item.itemSize && <span> (Size: {item.itemSize}) </span>}
                    x {item.quantity} - ${item.totalPrice ? item.totalPrice.toFixed(2) : '0.00'}
                  </span>
                </li>
              );
            })
          ) : (
            <li>No items in cart</li>
          )}
          {/* show additional costs and applied discounts */}
          <li className="cart-summary-shipping">Shipping: ${shippingCost ? shippingCost.toFixed(2) : '0.00'}</li>
          {discountValue > 0 && (
            <li className="cart-summary-discount">Discount (AURA20): -${discountValue.toFixed(2)}</li>
          )}
          <li className="cart-summary-total">
            <strong>Total: ${cartTotal ? cartTotal.toFixed(2) : '0.00'}</strong>
          </li>
        </ul>
      </section>

      {/* navigation buttons: back and final place order */}
      <div className="button-group">
        {/* disable back button while processing payment */}
        <button 
          type="button" 
          onClick={prevStep} 
          disabled={paymentStatus === 'processing'}
        >
          Go back
        </button>
        {/* final order button changes text and style according to payment state */}
        <button 
          type="button" 
          onClick={handleFinalOrder} 
          className={`btn-final-order status-${paymentStatus}`} 
          disabled={paymentStatus === 'processing' || paymentStatus === 'success'}
        >
          {buttonText[paymentStatus]}
        </button>
      </div>
    </div>
  );
};

export default Step4Summary;