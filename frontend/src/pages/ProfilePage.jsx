import React, { useState, useMemo } from 'react';
import { useAppContext } from '../context/AppContext';
import { confirmDialog } from '../components/ConfirmDialog';
import usePagination from '../hooks/usePagination';
import Pagination from '../components/Pagination';
import '../styles/pages/_profilePage.scss';
import toast from 'react-hot-toast';
import { Formik, Form, Field, ErrorMessage } from 'formik';
import * as Yup from 'yup';
import { validateEmail } from '../utils/validationUtils';

const ProfileSchema = Yup.object().shape({
  name: Yup.string()
    .min(2, 'Name is too short')
    .matches(/^[a-zA-Z\s-]+$/, 'Name can only contain letters'),
    
  surname: Yup.string()
    .min(2, 'Surname is too short')
    .matches(/^[a-zA-Z\s-]+$/, 'Surname can only contain letters'),
    
  email: Yup.string()
    .test('valid-email', 'Please enter a valid email address (e.g. user@domain.com)', validateEmail),
    
  phone: Yup.string()
    .matches(/^\+?[0-9\s-]{9,15}$/, 'Phone number must contain only digits (9-15 chars)'),
    
  address: Yup.string()
    .min(3, 'Address is too short'),

  house_number: Yup.string(),
    
  flat_number: Yup.string(),
  
  city: Yup.string()
    .min(2, 'City name is too short')
    .matches(/^[a-zA-Z\s-]+$/, 'City name cannot contain digits'),
    
  postalCode: Yup.string()
    .matches(/^\d{2}-\d{3}$/, 'Postal code must follow format XX-XXX (e.g. 00-001)'),
    
  country: Yup.string()
    .min(3, 'Country name is too short')
    .matches(/^[a-zA-Z\s-]+$/, 'Country name cannot contain digits'),
});

const ProfilePage = () => {
  const { profile, updateProfile, orders, removeOrder, logout } = useAppContext();
  const [isEditing, setIsEditing] = useState(false);

  // filter orders belonging to the current user
  const userOrders = useMemo(() => {
    return orders.filter(order => order.details?.email === profile.email);
  }, [orders, profile.email]);

  const pagination = usePagination(userOrders, 10, { paramName: 'profilePage' });

  // handle saving profile updates
  const handleSave = (values, { setSubmitting }) => {
    updateProfile(values);
    setIsEditing(false);
    setSubmitting(false);
    toast.success("Profile updated successfully");
  };

  const handleRemoveOrder = async (orderId) => {
    const confirmed = await confirmDialog.show(
      'Remove Order',
      `Do you want to remove order #${orderId} from your history?`
    );
    if (confirmed) {
        removeOrder(orderId);
        toast.success("Order removed from history");
    }
  };

  const handleLogout = async () => {
    const confirmed = await confirmDialog.show(
      'Log Out',
      'Are you sure you want to log out?'
    );

    if (confirmed) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      logout();
      toast.success("Logged out successfully");
    }
  };

  return (
    <div className="profile-page">
      <h1>My Profile</h1>

      <section className="profile-details">
        <h2>Personal Details</h2>

        <Formik
          initialValues={{
            name: profile.name || '',
            surname: profile.surname || '',
            email: profile.email || '',
            phone: profile.phone || '',
            address: profile.address || '',
            house_number: profile.house_number || '',
            flat_number: profile.flat_number || '',
            postalCode: profile.postalCode || '',
            city: profile.city || '',
            country: profile.country || ''
          }}
          validationSchema={ProfileSchema}
          onSubmit={handleSave}
          enableReinitialize={true} // updates form when profile changes
        >
          {({ values, errors, touched, resetForm, setValues }) => (
            <Form>
              <div className="form-group">
                <label htmlFor="name">Name</label>
                <Field 
                  type="text" 
                  name="name" 
                  disabled={!isEditing}
                  placeholder="e.g. John"
                  className={isEditing && touched.name && errors.name ? 'input-error' : ''}
                />
                {isEditing && <ErrorMessage name="name" component="div" className="error-message" />}
              </div>

              <div className="form-group">
                <label htmlFor="surname">Surname</label>
                <Field 
                  type="text" 
                  name="surname" 
                  disabled={!isEditing}
                  placeholder="e.g. Doe"
                  className={isEditing && touched.surname && errors.surname ? 'input-error' : ''}
                />
                {isEditing && <ErrorMessage name="surname" component="div" className="error-message" />}
              </div>

              <div className="form-group">
                <label htmlFor="email">Email</label>
                <Field 
                  type="email" 
                  name="email" 
                  disabled={!isEditing}
                  placeholder="e.g. email@example.com"
                  className={isEditing && touched.email && errors.email ? 'input-error' : ''}
                />
                {isEditing && <ErrorMessage name="email" component="div" className="error-message" />}
              </div>

              <div className="form-group">
                <label htmlFor="phone">Phone</label>
                <Field 
                  type="text" 
                  name="phone" 
                  disabled={!isEditing}
                  placeholder="e.g. 123456789"
                  className={isEditing && touched.phone && errors.phone ? 'input-error' : ''}
                />
                {isEditing && <ErrorMessage name="phone" component="div" className="error-message" />}
              </div>

              <div className="form-group">
                <label htmlFor="address">Street Address</label>
                <Field 
                  type="text" 
                  name="address" 
                  disabled={!isEditing}
                  placeholder="Street"
                  className={isEditing && touched.address && errors.address ? 'input-error' : ''}
                />
                {isEditing && <ErrorMessage name="address" component="div" className="error-message" />}
              </div>

              <div className="form-row" style={{ display: 'flex', gap: '1rem' }}>
                <div className="form-group" style={{ flex: 1 }}>
                  <label htmlFor="house_number">House Number</label>
                  <Field 
                    type="text" 
                    name="house_number" 
                    disabled={!isEditing}
                    placeholder="10A"
                    className={isEditing && touched.house_number && errors.house_number ? 'input-error' : ''}
                  />
                  {isEditing && <ErrorMessage name="house_number" component="div" className="error-message" />}
                </div>

                <div className="form-group" style={{ flex: 1 }}>
                  <label htmlFor="flat_number">Flat Number</label>
                  <Field 
                    type="text" 
                    name="flat_number" 
                    disabled={!isEditing}
                    placeholder="4"
                    className={isEditing && touched.flat_number && errors.flat_number ? 'input-error' : ''}
                  />
                  {isEditing && <ErrorMessage name="flat_number" component="div" className="error-message" />}
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="postalCode">Postal Code</label>
                <Field 
                  type="text" 
                  name="postalCode" 
                  disabled={!isEditing}
                  placeholder="00-000"
                  maxLength="6"
                  className={isEditing && touched.postalCode && errors.postalCode ? 'input-error' : ''}
                />
                {isEditing && <ErrorMessage name="postalCode" component="div" className="error-message" />}
              </div>

              <div className="form-group">
                <label htmlFor="city">City</label>
                <Field 
                  type="text" 
                  name="city" 
                  disabled={!isEditing}
                  placeholder="Warsaw"
                  className={isEditing && touched.city && errors.city ? 'input-error' : ''}
                />
                {isEditing && <ErrorMessage name="city" component="div" className="error-message" />}
              </div>

              <div className="form-group">
                <label htmlFor="country">Country</label>
                <Field 
                  type="text" 
                  name="country" 
                  disabled={!isEditing}
                  placeholder="Poland"
                  className={isEditing && touched.country && errors.country ? 'input-error' : ''}
                />
                {isEditing && <ErrorMessage name="country" component="div" className="error-message" />}
              </div>

              <div className="profile-actions">
                {!isEditing && (
                    <button type="button" onClick={() => setIsEditing(true)} className='btn-edit'>Edit Profile</button>
                )}
                {isEditing && (
                    <>
                        <button type="submit" className="btn-save">Save changes</button>
                        <button 
                            type="button" 
                            onClick={() => { 
                                setIsEditing(false); 
                                resetForm(); // revert to original profile values
                            }} 
                            className="btn-cancel"
                        >
                            Cancel
                        </button>
                    </>
                )}
            </div>
            </Form>
          )}
        </Formik>
      </section>

      <section className="order-history user-view">
        <h2>My Order History ({userOrders.length})</h2>
        <div className="orders-list">
          <div className="order-item header">
            <span className="order-id">ID</span>
            <span className="order-date">Date</span>
            <span className="order-total">Total</span>
            <span className="order-status">Status</span>
            <span className="order-actions">Actions</span>
          </div>
          
          {pagination.paginatedItems.map(order => (
            <div key={order.id} className="order-item">
              <span className="order-id" data-label="ID">#ORD-{String(order.id).padStart(4, '0')}</span>
              <span className="order-date" data-label="Date">{new Date(order.date).toLocaleDateString()}</span>
              <span className="order-total" data-label="Total"><strong>${order.total.toFixed(2)}</strong></span>
              <span className={`order-status status-${order.status.toLowerCase()}`} data-label="Status">{order.status}</span>
              <div className="order-actions" data-label="Actions">
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
      </section>

      <div className="account-actions">
            <button className="logout-btn-large" onClick={handleLogout}>Log Out</button>
        </div>
    </div>
  );
};
export default ProfilePage;
