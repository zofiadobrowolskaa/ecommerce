import React, { useState } from 'react';
import { useAppContext } from '../../context/AppContext';
import toast from 'react-hot-toast';
import { confirmDialog } from '../ConfirmDialog';
import { Formik, Form, Field, FieldArray, ErrorMessage } from 'formik';
import * as Yup from 'yup';
import '../../styles/pages/_productManagement.scss';

const defaultMaterials = {
    "925SterlingSilver": "All silver pieces are made with 925 sterling silver, Aura's signature material and the industry standard. 92.5% pure silver, highly durable for daily wear.",
    "10KSolidGold": "All gold pieces are made with 10K Solid Gold. More durable and scratch-resistant than 14k gold, ideal for everyday wear.",
    "GoldVermeil": "Crafted with 92% recycled sterling silver and thick gold layer. Tarnish-resistant, hypoallergenic, perfect for daily wear.",
    "Gemstones": "High-quality precious and semi-precious gemstones selected for beauty and longevity."
};

const EditorVariantSchema = Yup.object().shape({
    id: Yup.string()
        .required('Variant ID is required')
        .matches(/^[a-zA-Z0-9-_]+$/, 'Only letters, numbers, dash and underscore'),
    color: Yup.string()
        .required('Color name is required')
        .min(2, 'Color name too short'),
    priceAdjustment: Yup.number()
        .min(0, 'Price adjustment cannot be negative')
        .required('Price adjustment is required'),
    size: Yup.string(),
    imageUrl: Yup.string()
        .required('Image path is required')
});

const ProductSchema = Yup.object().shape({
    id: Yup.string()
        .required('Product ID is required')
        .matches(/^[a-zA-Z0-9]+$/, 'ID must be alphanumeric (no spaces)'),
    name: Yup.string()
        .min(3, 'Name is too short')
        .required('Product name is required'),
    category: Yup.string()
        .required('Category is required'),
    price: Yup.number()
        .positive('Price must be greater than 0')
        .required('Base price is required'),
    description: Yup.string()
        .min(10, 'Description should be longer'),
    variants: Yup.array()
        .min(1, 'You must add at least one variant')
});

const ProductForm = ({ initialData, onSuccess, onCancel }) => {
    const { addProduct, updateProduct, products } = useAppContext();
    const isEditing = !!initialData;
    const [editingVariantIndex, setEditingVariantIndex] = useState(null);

    const initialValues = {
        id: initialData?.id || '',
        name: initialData?.name || '',
        category: initialData?.category || '',
        price: initialData?.price || '',
        description: initialData?.description || '',
        tags: initialData?.tags ? initialData.tags.join(', ') : '',
        rating: initialData?.rating || '4.5',
        variants: initialData?.variants || [],
        editorVariant: {
            id: '',
            color: '',
            priceAdjustment: 0,
            imageUrl: '',
            size: ''
        }
    };

    // save or update a variant
    const handleSaveVariant = async (values, arrayHelpers, formikHelpers) => {
        const { setFieldError, setFieldTouched, setFieldValue } = formikHelpers;

        try {
            // validate variant sub-form
            await EditorVariantSchema.validate(values.editorVariant, { abortEarly: false });
            const newVariant = values.editorVariant;

            // check for duplicate variant ID
            const isDuplicate = values.variants.some((v, index) => 
                v.id === newVariant.id && index !== editingVariantIndex
            );
            if (isDuplicate) {
                setFieldError('editorVariant.id', 'Variant ID must be unique inside this product!');
                setFieldTouched('editorVariant.id', true, false);
                return;
            }

            // format variant data; size is optional (e.g. earrings have no size)
            const formattedVariant = {
                ...newVariant,
                priceAdjustment: Number(newVariant.priceAdjustment),
                size: newVariant.size
                    ? (newVariant.size.includes(',')
                        ? newVariant.size.split(',').map(s => s.trim()).filter(Boolean)
                        : [newVariant.size.trim()])
                    : []
            };

            // add or update variant
            if (editingVariantIndex !== null) {
                arrayHelpers.replace(editingVariantIndex, formattedVariant);
                toast.success("Variant updated");
                setEditingVariantIndex(null);
            } else {
                arrayHelpers.push(formattedVariant);
                toast.success("Variant added");
            }

            // reset editor variant fields
            setFieldValue('editorVariant', {
                id: '',
                color: '',
                priceAdjustment: 0,
                imageUrl: '',
                size: ''
            });
            setFieldTouched('editorVariant', false);

        } catch (err) {
            if (err.inner && err.inner.length > 0) {
                err.inner.forEach(error => {
                    const fieldName = `editorVariant.${error.path}`;
                    setFieldError(fieldName, error.message);
                    setFieldTouched(fieldName, true, false);
                });
            }
        }
    };

    // load variant into editor for editing
    const handleEditVariantClick = (index, variant, setFieldValue) => {
        setEditingVariantIndex(index);
        setFieldValue('editorVariant', {
            ...variant,
            size: Array.isArray(variant.size) ? variant.size.join(', ') : variant.size
        });
    };

    // submit product form — async to await backend api calls
    const handleSubmit = async (values, { setSubmitting }) => {
        if (!isEditing) {
            // check for duplicate sku before creating
            const exists = products.find(p => p.sku === values.id || p.id === values.id);
            if (exists) {
                toast.error(`Product ID ${values.id} already exists!`);
                setSubmitting(false);
                return;
            }
        }

        const productPayload = {
            ...values,
            _id: initialData?._id,  // numeric postgres id passed through for update calls
            price: Number(values.price),
            rating: Number(values.rating),
            tags: values.tags.split(',').map(t => t.trim()).filter(Boolean),
            aboutMaterials: initialData?.aboutMaterials || defaultMaterials
        };
        delete productPayload.editorVariant;

        try {
            if (isEditing) {
                await updateProduct(productPayload);
                toast.success("Product updated successfully");
            } else {
                await addProduct(productPayload);
                toast.success("Product created successfully");
            }
            onSuccess();
        } catch {
            toast.error(isEditing ? "Failed to update product. Please try again." : "Failed to create product. Please try again.");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="admin-editor-container">
            <Formik
                initialValues={initialValues}
                validationSchema={ProductSchema}
                onSubmit={handleSubmit}
                enableReinitialize
            >
                {({ values, errors, touched, setFieldValue, setFieldError, setFieldTouched }) => (
                    <Form className="main-form">
                        
                        <section className="form-section">
                            <h3>1. General Information</h3>
                            <div className="form-grid">
                                <div className="field-group">
                                    <label>Product ID *</label>
                                    <Field 
                                        name="id" 
                                        placeholder="p001" 
                                        disabled={isEditing} 
                                        className={touched.id && errors.id ? 'input-error' : ''}
                                    />
                                    <ErrorMessage name="id" component="div" className="error-message" />
                                </div>
                                <div className="field-group">
                                    <label>Name *</label>
                                    <Field 
                                        name="name" 
                                        className={touched.name && errors.name ? 'input-error' : ''}
                                    />
                                    <ErrorMessage name="name" component="div" className="error-message" />
                                </div>
                                <div className="field-group">
                                    <label>Category *</label>
                                    <Field as="select" name="category" className={touched.category && errors.category ? 'input-error' : ''}>
                                        <option value="">Select...</option>
                                        <option value="Rings">Rings</option>
                                        <option value="Necklaces">Necklaces</option>
                                        <option value="Earrings">Earrings</option>
                                        <option value="Bracelets">Bracelets</option>
                                    </Field>
                                    <ErrorMessage name="category" component="div" className="error-message" />
                                </div>
                                <div className="field-group">
                                    <label>Base Price ($) *</label>
                                    <Field 
                                        type="number" 
                                        name="price" 
                                        step="0.01" 
                                        className={touched.price && errors.price ? 'input-error' : ''}
                                    />
                                    <ErrorMessage name="price" component="div" className="error-message" />
                                </div>
                                <div className="field-group full-width">
                                    <label>Description</label>
                                    <Field as="textarea" name="description" rows="3" />
                                    <ErrorMessage name="description" component="div" className="error-message" />
                                </div>
                                <div className="field-group full-width">
                                    <label>Tags (comma separated)</label>
                                    <Field name="tags" placeholder="silver, gift, summer" />
                                </div>
                            </div>
                        </section>

                        <section className="form-section variants-section">
                            <h3>2. Variants Manager</h3>
                            
                            <FieldArray name="variants">
                                {(arrayHelpers) => (
                                    <>
                                        <div className="variants-table-wrapper">
                                            {values.variants.length === 0 ? (
                                                <p className="no-data">No variants added yet. Add at least one.</p>
                                            ) : (
                                                <table className="variants-mini-table">
                                                    <thead>
                                                        <tr>
                                                            <th>ID</th>
                                                            <th>Color</th>
                                                            <th>+Price</th>
                                                            <th>Image</th>
                                                            <th>Actions</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {values.variants.map((v, index) => (
                                                            <tr key={v.id || index} className={editingVariantIndex === index ? 'active-row' : ''}>
                                                                <td>{v.id}</td>
                                                                <td>{v.color}</td>
                                                                <td>+${v.priceAdjustment}</td>
                                                                <td>{v.imageUrl && <img src={v.imageUrl} alt="prev" className="mini-thumb" />}</td>
                                                                <td>
                                                                    <button 
                                                                        type="button" 
                                                                        onClick={() => handleEditVariantClick(index, v, setFieldValue)} 
                                                                        className="btn-icon"
                                                                    >
                                                                        ✎
                                                                    </button>
                                                                    <button 
                                                                        type="button" 
                                                                        onClick={async () => {
                                                                            if(await confirmDialog.show('Remove?', `Remove variant ${v.id}?`)) {
                                                                                arrayHelpers.remove(index);
                                                                            }
                                                                        }} 
                                                                        className="btn-icon delete"
                                                                    >
                                                                        ×
                                                                    </button>
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            )}
                                            {typeof errors.variants === 'string' && (
                                                <div className="error-message center-text">{errors.variants}</div>
                                            )}
                                        </div>

                                        <div className="variant-editor-box">
                                            <h4>{editingVariantIndex !== null ? 'Edit Variant' : 'Add New Variant'}</h4>
                                            
                                            <div className="variant-form-row">
                                                <div className="v-field">
                                                    <label>Variant ID</label>
                                                    <Field 
                                                        name="editorVariant.id" 
                                                        placeholder="e.g. v001a" 
                                                        disabled={editingVariantIndex !== null}
                                                        className={touched.editorVariant?.id && errors.editorVariant?.id ? 'input-error' : ''}
                                                    />
                                                    <ErrorMessage name="editorVariant.id" component="div" className="error-message" />
                                                </div>
                                                <div className="v-field">
                                                    <label>Color / Name</label>
                                                    <Field 
                                                        name="editorVariant.color" 
                                                        placeholder="e.g. Gold" 
                                                        className={touched.editorVariant?.color && errors.editorVariant?.color ? 'input-error' : ''}
                                                    />
                                                    <ErrorMessage name="editorVariant.color" component="div" className="error-message" />
                                                </div>
                                                <div className="v-field">
                                                    <label>+ Price ($)</label>
                                                    <Field 
                                                        type="number" 
                                                        name="editorVariant.priceAdjustment" 
                                                        placeholder="0" 
                                                        className={touched.editorVariant?.priceAdjustment && errors.editorVariant?.priceAdjustment ? 'input-error' : ''}
                                                    />
                                                    <ErrorMessage name="editorVariant.priceAdjustment" component="div" className="error-message" />
                                                </div>
                                            </div>

                                            <div className="variant-form-row">
                                                <div className="v-field flex-grow">
                                                    <label>Image Path (e.g. /img/...)</label>
                                                    <Field 
                                                        name="editorVariant.imageUrl" 
                                                        placeholder="/img/p001.jpg" 
                                                        className={touched.editorVariant?.imageUrl && errors.editorVariant?.imageUrl ? 'input-error' : ''}
                                                    />
                                                    <ErrorMessage name="editorVariant.imageUrl" component="div" className="error-message" />
                                                </div>
                                                <div className="v-field flex-grow">
                                                    <label>Sizes (comma separated)</label>
                                                    <Field 
                                                        name="editorVariant.size" 
                                                        placeholder="6, 7, 8" 
                                                        className={touched.editorVariant?.size && errors.editorVariant?.size ? 'input-error' : ''}
                                                    />
                                                    <ErrorMessage name="editorVariant.size" component="div" className="error-message" />
                                                </div>
                                            </div>

                                            <div className="variant-actions">
                                                <button 
                                                    type="button" 
                                                    onClick={() => handleSaveVariant(values, arrayHelpers, { setFieldError, setFieldTouched, setFieldValue })} 
                                                    className="btn-save-variant"
                                                >
                                                    {editingVariantIndex !== null ? 'Update Variant' : 'Add Variant'}
                                                </button>
                                                
                                                {editingVariantIndex !== null && (
                                                    <button 
                                                        type="button" 
                                                        onClick={() => {
                                                            setEditingVariantIndex(null);
                                                            setFieldValue('editorVariant', initialValues.editorVariant);
                                                            setFieldTouched('editorVariant', false);
                                                        }} 
                                                        className="btn-cancel-variant"
                                                    >
                                                        Cancel Edit
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </>
                                )}
                            </FieldArray>
                        </section>

                        <div className="form-footer sticky-footer">
                            <button type="button" onClick={onCancel} className="btn-cancel-main">Cancel</button>
                            <button type="submit" className="btn-save-main">Save Product</button>
                        </div>
                    </Form>
                )}
            </Formik>
        </div>
    );
};

export default ProductForm;
