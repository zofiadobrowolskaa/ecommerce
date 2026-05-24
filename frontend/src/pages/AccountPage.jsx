import React, { useState } from 'react';
import { useAppContext } from '../context/AppContext';
import ProfilePage from './ProfilePage';
import toast from 'react-hot-toast';
import '../styles/pages/_accountPage.scss';
import { useNavigate } from 'react-router-dom';
import { Formik, Form, Field, ErrorMessage } from 'formik';
import * as Yup from 'yup';
import { validateEmail } from '../utils/validationUtils';

const LoginSchema = Yup.object().shape({
  email: Yup.string()
    .required('Email is required')
    .test('valid-email', 'Please enter a valid email address (e.g. user@domain.com)', validateEmail),
  password: Yup.string()
    .required('Password is required'),
});

const RegisterSchema = Yup.object().shape({
  name: Yup.string()
    .min(2, 'Name is too short')
    .matches(/^[\p{L}\s-]+$/u, 'Name can only contain letters')
    .required('Name is required'),
  surname: Yup.string()
    .min(2, 'Surname is too short')
    .matches(/^[\p{L}\s-]+$/u, 'Surname can only contain letters')
    .required('Surname is required'),
  email: Yup.string()
    .required('Email is required')
    .test('valid-email', 'Please enter a valid email address (e.g. user@domain.com)', validateEmail),
  password: Yup.string()
    .min(6, 'Password must be at least 6 characters')
    .required('Password is required'),
  confirmPassword: Yup.string()
    .oneOf([Yup.ref('password'), null], 'Passwords must match')
    .required('Confirm Password is required'),
});

const AccountPage = () => {
  const { user, login, register } = useAppContext();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('login');

  const handleLoginSubmit = async (values, { setSubmitting }) => {
    const result = await login(values.email, values.password);
    setSubmitting(false);
    
    if (result.success) {
      toast.success('Logged in successfully!');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      navigate('/');
    } else {
      toast.error(result.message);
    }
  };

  const handleRegisterSubmit = async (values, { setSubmitting }) => {
    const result = await register(values.email, values.password, values.name, values.surname);
    setSubmitting(false);

    if (result.success) {
      toast.success('Account created successfully!');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      navigate('/');
    } else {
      toast.error(result.message);
    }
  };

  // logged in user view
  if (user) {
    return <ProfilePage />;
  }

  return (
    <div className="account-page">
      <div className="auth-card">
        {/* tabs to switch between Login and Register */}
        <div className="auth-tabs">
          <button 
            className={`tab-btn ${activeTab === 'login' ? 'active' : ''}`}
            onClick={() => setActiveTab('login')}
          >
            Login
          </button>
          <button 
            className={`tab-btn ${activeTab === 'register' ? 'active' : ''}`}
            onClick={() => setActiveTab('register')}
          >
            Register
          </button>
        </div>

        {/* form content based on active tab */}
        <div className="auth-content">
          {activeTab === 'login' ? (
            <Formik
              key="login"
              initialValues={{ email: '', password: '' }}
              validationSchema={LoginSchema}
              onSubmit={handleLoginSubmit}
            >
              {({ isSubmitting, touched, errors }) => (
                <Form className="auth-form fade-in">
                  <h2>Welcome Back</h2>
                  
                  <div className="form-group">
                    <label htmlFor="login-email">Email Address</label>
                    <Field 
                      type="email" 
                      name="email"
                      id="login-email"
                      placeholder="Enter your email"
                      className={touched.email && errors.email ? 'input-error' : ''}
                    />
                    <ErrorMessage name="email" component="div" className="error-message" />
                  </div>

                  <div className="form-group">
                    <label htmlFor="login-password">Password</label>
                    <Field 
                      type="password" 
                      name="password"
                      id="login-password"
                      placeholder="Enter your password"
                      className={touched.password && errors.password ? 'input-error' : ''}
                    />
                    <ErrorMessage name="password" component="div" className="error-message" />
                  </div>

                  <button type="submit" className="auth-submit-btn" disabled={isSubmitting}>
                    {isSubmitting ? 'Processing...' : 'Login'}
                  </button>
                </Form>
              )}
            </Formik>
          ) : (
         
            <Formik
              key="register"
              initialValues={{ name: '', surname: '', email: '', password: '', confirmPassword: '' }}
              validationSchema={RegisterSchema}
              onSubmit={handleRegisterSubmit}
            >
              {({ isSubmitting, touched, errors }) => (
                <Form className="auth-form fade-in">
                  <h2>Create Account</h2>
                  
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="reg-name">First Name</label>
                      <Field 
                        type="text" 
                        name="name"
                        id="reg-name"
                        placeholder="Enter your name"
                        className={touched.name && errors.name ? 'input-error' : ''}
                      />
                      <ErrorMessage name="name" component="div" className="error-message" />
                    </div>
                    
                    <div className="form-group">
                      <label htmlFor="reg-surname">Last Name</label>
                      <Field 
                        type="text" 
                        name="surname"
                        id="reg-surname"
                        placeholder="Enter your surname"
                        className={touched.surname && errors.surname ? 'input-error' : ''}
                      />
                      <ErrorMessage name="surname" component="div" className="error-message" />
                    </div>
                  </div>

                  <div className="form-group">
                    <label htmlFor="reg-email">Email Address</label>
                    <Field 
                      type="email" 
                      name="email"
                      id="reg-email"
                      placeholder="Enter your email"
                      className={touched.email && errors.email ? 'input-error' : ''}
                    />
                    <ErrorMessage name="email" component="div" className="error-message" />
                  </div>
                  
                  <div className="form-group">
                    <label htmlFor="reg-password">Password</label>
                    <Field 
                      type="password" 
                      name="password"
                      id="reg-password"
                      placeholder="Min. 6 characters"
                      className={touched.password && errors.password ? 'input-error' : ''}
                    />
                    <ErrorMessage name="password" component="div" className="error-message" />
                  </div>

                  <div className="form-group">
                    <label htmlFor="reg-confirmPassword">Confirm Password</label>
                    <Field 
                      type="password" 
                      name="confirmPassword"
                      id="reg-confirmPassword"
                      placeholder="Repeat password"
                      className={touched.confirmPassword && errors.confirmPassword ? 'input-error' : ''}
                    />
                    <ErrorMessage name="confirmPassword" component="div" className="error-message" />
                  </div>

                  <button type="submit" className="auth-submit-btn" disabled={isSubmitting}>
                    {isSubmitting ? 'Processing...' : 'Create Account'}
                  </button>
                </Form>
              )}
            </Formik>
          )}
        </div>
      </div>
    </div>
  );
};

export default AccountPage;
