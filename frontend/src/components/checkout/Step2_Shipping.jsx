import React from 'react';
import { Formik, Form, Field, ErrorMessage } from 'formik';
import * as Yup from 'yup';

const Step2Schema = Yup.object().shape({
  address: Yup.string()
    .min(3, 'Address is too short')
    .required('Street address is required'),

  house_number: Yup.string()
    .required('House number is required'),

  flat_number: Yup.string(),

  city: Yup.string()
    .min(2, 'City name is too short')
    .matches(/^[\p{L}\s-]+$/u, 'City name cannot contain digits')
    .required('City is required'),

  postalCode: Yup.string()
    .matches(/^\d{2}-\d{3}$/, 'Postal code must follow format XX-XXX (e.g. 00-001)')
    .required('Postal code is required'),

  country: Yup.string()
    .min(3, 'Country name is too short')
    .matches(/^[\p{L}\s-]+$/u, 'Country name cannot contain digits')
    .required('Country is required'),

  shippingMethod: Yup.string()
    .oneOf(['standard', 'express'], 'Invalid shipping method')
    .required('Shipping method is required'),
});

const Step2Shipping = ({ nextStep, prevStep, formData, setFormData }) => {

  // handle form submission after successful validation
  const handleSubmit = (values) => {
    // update parent form state to preserve data for next steps
    setFormData(prev => ({ ...prev, ...values }));
    // proceed to the next step
    nextStep(values);
  };

  return (
    <Formik
      // initialize form fields from props to retain previous values
      initialValues={{
        address: formData.address || '',
        house_number: formData.house_number || '',
        flat_number: formData.flat_number || '',
        city: formData.city || '',
        postalCode: formData.postalCode || '',
        country: formData.country || '',
        shippingMethod: formData.shippingMethod || 'standard'
      }}
      validationSchema={Step2Schema}
      onSubmit={handleSubmit}
    >
      {({ errors, touched }) => (
        <Form className="checkout-step">
          <h2>2. Address and Shipping</h2>

          <div className="form-group-wrapper">
            <Field
              type="text"
              name="address"
              placeholder="Street address"
              className={touched.address && errors.address ? 'input-error' : ''}
            />
            <ErrorMessage name="address" component="p" className="error-message" />
          </div>

          <div className="form-row" style={{ display: 'flex', gap: '10px' }}>
            <div className="form-group-wrapper" style={{ flex: 1 }}>
              <Field
                type="text"
                name="house_number"
                placeholder="House number"
                className={touched.house_number && errors.house_number ? 'input-error' : ''}
              />
              <ErrorMessage name="house_number" component="p" className="error-message" />
            </div>

            <div className="form-group-wrapper" style={{ flex: 1 }}>
              <Field
                type="text"
                name="flat_number"
                placeholder="Flat number (optional)"
                className={touched.flat_number && errors.flat_number ? 'input-error' : ''}
              />
              <ErrorMessage name="flat_number" component="p" className="error-message" />
            </div>
          </div>

          <div className="form-group-wrapper">
            <Field
              type="text"
              name="city"
              placeholder="City"
              className={touched.city && errors.city ? 'input-error' : ''}
            />
            <ErrorMessage name="city" component="p" className="error-message" />
          </div>

          <div className="form-group-wrapper">
            <Field
              type="text"
              name="postalCode"
              placeholder="Postal code (XX-XXX)"
              maxLength="6" // limit input length for better UX
              className={touched.postalCode && errors.postalCode ? 'input-error' : ''}
            />
            <ErrorMessage name="postalCode" component="p" className="error-message" />
          </div>

          <div className="form-group-wrapper">
            <Field
              type="text"
              name="country"
              placeholder="Country"
              className={touched.country && errors.country ? 'input-error' : ''}
            />
            <ErrorMessage name="country" component="p" className="error-message" />
          </div>

          <div className="shipping-method">
            <label>Shipping method:</label>
            <Field as="select" name="shippingMethod">
              <option value="standard">Standard $5</option>
              <option value="express">Express $15</option>
            </Field>
            <ErrorMessage name="shippingMethod" component="p" className="error-message" />
          </div>

          <div className="button-group">
            {/* type="button" prevents form validation when going back */}
            <button type="button" onClick={prevStep}>Go back</button>
            <button type="submit">Next to Payment</button>
          </div>
        </Form>
      )}
    </Formik>
  );
};

export default Step2Shipping;
