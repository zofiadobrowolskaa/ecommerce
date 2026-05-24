import React, { useState, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import ProductForm from '../components/admin/ProductForm';
import { confirmDialog } from '../components/ConfirmDialog';
import usePagination from '../hooks/usePagination';
import Pagination from '../components/Pagination';
import toast from 'react-hot-toast';
import '../styles/pages/_productManagement.scss';

const VIEW = {
    LIST: 'LIST',
    CREATE: 'CREATE'
};

const ProductManagementPage = () => {
    const { products, deleteProduct, resetAppData } = useAppContext();
    const [currentView, setCurrentView] = useState(VIEW.LIST);

    const pagination = usePagination(products, 10, { paramName: 'adminPage' });

    useEffect(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, [currentView]);

    // switch to create product view
    const handleCreateClick = () => setCurrentView(VIEW.CREATE);

    // return to product list
    const handleBackToList = () => setCurrentView(VIEW.LIST);

    const handleDeleteProduct = async (id, name) => {
        const confirmed = await confirmDialog.show(
            'Delete Product',
            `Are you sure you want to delete product "${name}" and ALL its variants?`
        );
        if (confirmed) {
            try {
                // deleteProduct calls DELETE /api/products/:id and updates local state on success
                await deleteProduct(id);
                toast.success("Product deleted successfully");
            } catch {
                toast.error("Failed to delete product. Please try again.");
            }
        }
    };

    // factory reset database to default state
    const handleFactoryReset = async () => {
        const confirmed = await confirmDialog.show(
            'Reset Database?',
            'This will restore all products to their default state (from JSON) and clear all orders. This cannot be undone.'
        );
        if (confirmed) {
            resetAppData();
            toast.success("Database reset to defaults!");
        }
    };

    // render create product form view
    if (currentView === VIEW.CREATE) {
        return (
            <div className="product-management-page">
                <div className="editor-header">
                    <button onClick={handleBackToList} className="btn-back">
                        &larr; Back to List
                    </button>
                    <h1>Create New Product</h1>
                </div>
                
                <ProductForm 
                    initialData={null}
                    onSuccess={handleBackToList}
                    onCancel={handleBackToList}
                />
            </div>
        );
    }

    // render list view (VIEW.LIST)
    return (
        <div className="product-management-page">
            <div className="page-header">
                <h1>Product Inventory</h1>
                <div className="header-actions">
                    <button onClick={handleFactoryReset} className="btn-reset-data">
                        ↺ Reset Data
                    </button>
                    <button onClick={handleCreateClick} className="btn-create-new">
                        + New Product
                    </button>
                </div>
            </div>

            <div className="product-admin-list">
                <div className="list-header grid-layout-parent">
                    <span>Image</span>
                    <span>ID / Name</span>
                    <span>Category</span>
                    <span>Variants</span>
                    <span>Base Price</span>
                    <span>Actions</span>
                </div>

                {pagination.paginatedItems.map(product => {
                    const variantCount = product.variants?.length || 0;
                    const prices = product.variants?.map(v => product.price + (v.priceAdjustment || 0)) || [product.price];
                    const minPrice = Math.min(...prices);
                    const maxPrice = Math.max(...prices);
                    const priceDisplay = minPrice === maxPrice 
                        ? `$${minPrice.toFixed(2)}` 
                        : `$${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)}`;

                    const mainImg = product.variants?.[0]?.imageUrl || '/img/placeholder.jpg';
                    
                    // ZMODYFIKOWANE: Odtwarzamy tekst z liczby
                    const categoryDict = { 1: "Rings", 2: "Earrings", 3: "Necklaces", 4: "Bracelets" };
                    const categoryName = categoryDict[product.category_id] || product.category || 'Unknown';

                    return (
                        <div key={product.id} className="admin-product-item grid-layout-parent">
                            <div className="img-wrapper">
                                <img src={mainImg} alt={product.name} />
                            </div>
                            <div className="info-col">
                                <span className="id-badge">{product.id}</span>
                                <span className="name">{product.name}</span>
                            </div>
                            <span className="category">{categoryName}</span>
                            <span className="variants">
                               {variantCount} {variantCount === 1 ? 'variant' : 'variants'}
                            </span>
                            <span className="price">{priceDisplay}</span>
                            
                            <div className="actions">
                                <button
                                    onClick={() => handleDeleteProduct(product.id, product.name)}
                                    className="btn-delete"
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    );
                })}
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
        </div>
    );
};

export default ProductManagementPage;
