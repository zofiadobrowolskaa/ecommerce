import React from 'react';
import { Formik, Form, Field, ErrorMessage } from 'formik';
import * as Yup from 'yup';
import { validateEmail } from '../../utils/validationUtils';

const Step1Schema = Yup.object().shape({
  name: Yup.string()
    .min(2, 'Name must be at least 2 characters')
    .matches(/^[\p{L}\s-]+$/u, 'Name can only contain letters')
    .required('Name is required'),

  surname: Yup.string()
    .min(2, 'Surname must be at least 2 characters')
    .matches(/^[a-zA-Z\s-]+$/, 'Surname can only contain letters')
    .required('Surname is required'),

  email: Yup.string()
    .required('Email is required')
    .test('valid-email', 'Please enter a valid email address (e.g. user@domain.com)', validateEmail),

  phone: Yup.string()
    .matches(/^\+?[0-9\s-]{9,15}$/, 'Phone number must contain only digits (9-15 chars)')
    .required('Phone number is required'),
});

const Step1Details = ({ nextStep, formData, setFormData }) => {

  // handle form submission after successful validation
  const handleSubmit = (values) => {
    // update global form state to preserve data when navigating back
    setFormData(prev => ({ ...prev, ...values }));
    
    // proceed to the next step
    nextStep(values);
  };

  return (
    <Formik
      // set initial values from props to retain data when returning back
      initialValues={{
        name: formData.name || '',
        surname: formData.surname || '',
        email: formData.email || '',
        phone: formData.phone || ''
      }}
      validationSchema={Step1Schema}
      onSubmit={handleSubmit}
    >
      {({ errors, touched }) => (
        <Form className="checkout-step">
          <h2>1. Contact information</h2>
          
          <div className="form-group-wrapper">
            <Field 
              type="text" 
              name="name" 
              placeholder="Name"
              className={touched.name && errors.name ? 'input-error' : ''}
            />
            <ErrorMessage name="name" component="p" className="error-message" />
          </div>

          <div className="form-group-wrapper">
            <Field 
              type="text" 
              name="surname" 
              placeholder="Surname"
              className={touched.surname && errors.surname ? 'input-error' : ''}
            />
            <ErrorMessage name="surname" component="p" className="error-message" />
          </div>

          <div className="form-group-wrapper">
            <Field 
              type="email" 
              name="email" 
              placeholder="Email"
              className={touched.email && errors.email ? 'input-error' : ''}
            />
            <ErrorMessage name="email" component="p" className="error-message" />
          </div>

          <div className="form-group-wrapper">
            <Field 
              type="tel" 
              name="phone" 
              placeholder="Phone number (e.g. 123456789)" 
              className={touched.phone && errors.phone ? 'input-error' : ''}
            />
            <ErrorMessage name="phone" component="p" className="error-message" />
          </div>
          
          <div className="button-group">
            {/* submit button triggers validation automatically */}
            <button type="submit">Next to Shipping</button>
          </div>
        </Form>
      )}
    </Formik>
  );
};

export default Step1Details;
