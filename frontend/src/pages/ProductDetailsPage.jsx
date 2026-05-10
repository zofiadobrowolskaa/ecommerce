import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAppContext } from '../context/AppContext';
import RelatedProducts from '../components/RelatedProducts';
import toast from 'react-hot-toast';
import '../styles/pages/_productDetailsPage.scss';

const ProductDetailsPage = () => {
  const { id, variantId } = useParams();
  const navigate = useNavigate();
  const { addToCart } = useAppContext(); 

  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [selectedVariantId, setSelectedVariantId] = useState(variantId);
  const [quantity, setQuantity] = useState(1);
  const [selectedSize, setSelectedSize] = useState(null);

  // fetch single product details from api gateway
  useEffect(() => {
    let isMounted = true;

    const fetchProductDetails = async () => {
      try {
        setLoading(true);
        setProduct(null); // NAPRAWA 1: Natychmiastowe czyszczenie starego produktu
        
        const response = await fetch(`http://localhost:3000/api/products/${id}`);
        
        if (!response.ok) {
           if (response.status === 404) throw new Error("product not found");
           throw new Error("Failed to fetch product details");
        }
        
        const data = await response.json();
        if (isMounted) setProduct(data);
      } catch (err) {
        if (isMounted) setError(err.message);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    if (id) {
       fetchProductDetails();
    }

    return () => { isMounted = false; };
  }, [id]);

  // sync URL variantId with state once product is loaded
  useEffect(() => {
    if (product && product.variants && product.variants.length > 0) {
      
      // NAPRAWA 2: Blokujemy redirect, jeśli produkt w state nie pasuje do URL (zapobiega to zacinaniu Related Products)
      const isCorrectProductLoaded = String(product.id) === String(id) || String(product.sku) === String(id);
      if (!isCorrectProductLoaded) return;

      const productIdForUrl = product.sku || product.id;

      if (!variantId || variantId === 'base') {
        const defaultVariantId = product.variants[0].id;
        navigate(`/products/${productIdForUrl}/${defaultVariantId}`, { replace: true });
        return;
      }

      const variantExists = product.variants.some(v => v.id === variantId);

      if (variantExists) {
        if (selectedVariantId !== variantId) {
          setSelectedVariantId(variantId);

          const currentVariantFromUrl = product.variants.find(v => v.id === variantId);
          setSelectedSize(currentVariantFromUrl?.size?.[0] || null);
          setQuantity(1);
        }
      } else {
        const defaultVariantId = product.variants[0].id;
        navigate(`/products/${productIdForUrl}/${defaultVariantId}`, { replace: true });
      }
    }
  }, [id, variantId, product, navigate]);

  // scroll to top on product change
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [id]);

  if (loading) return <div className="product-details-page">Loading details...</div>;

  if (error) {
    return (
      <div className="product-details-404">
        <h1>{error}</h1>
        <button onClick={() => navigate('/products')}>Go back to products page</button>
      </div>
    );
  }

  if (!product) return null;

  // find currently selected variant
  const currentVariant =
    product.variants?.find(v => v.id === selectedVariantId) ||
    product.variants?.[0];

  // calculate final price including variant adjustment
  const basePrice = Number(product.price) || 0;
  const finalPrice = basePrice + (currentVariant?.priceAdjustment || 0);

  // update variant selection and reset dependent state
  const handleVariantChange = (newVariantId) => {
    navigate(`/products/${id}/${newVariantId}`);
    setSelectedVariantId(newVariantId);

    const newVariant = product.variants.find(v => v.id === newVariantId);
    setSelectedSize(newVariant?.size?.[0] || null);
    setQuantity(1);
  };

  // add selected product variant to cart with validation
  const handleAddToCart = () => {
    if (!selectedVariantId) {
      toast.error('Please select a variant before adding to cart');
      return;
    }

    const qtyNumber = Number(quantity);

    if (!quantity || qtyNumber === 0) {
      toast.error('You cannot add 0 products to the cart');
      return;
    }

    addToCart(product.id, selectedVariantId, qtyNumber, selectedSize);

    const sizeInfo = selectedSize ? ` size: ${selectedSize}` : '';
    const variantInfo = currentVariant?.color ? ` (${currentVariant.color})` : '';

    toast.success(
      `Added ${qtyNumber}x ${product.name}${variantInfo}${sizeInfo} to cart!`
    );
  };

  return (
    <div className="product-details-page">
      <div className="product-main-info">
        <div className="product-image-gallery">
          <img
            src={
              currentVariant?.imageUrl ||
              product.gallery?.[0] ||
              '/img/placeholder.jpg'
            }
            alt={product.name}
            className="main-image"
          />
        </div>

        <div className="product-details-content">
          <h1>{product.name}</h1>
          <p className="price">${finalPrice.toFixed(2)}</p>
          <p className="description">{product.description}</p>

          {/* variant selector */}
          {product.variants && product.variants.length > 0 && (
            <div className="options-group">
              <label>Variant ({currentVariant?.color}):</label>
              <div className="variant-selector">
                {product.variants.map(variant => (
                  <button
                    key={variant.id}
                    onClick={() => handleVariantChange(variant.id)}
                    className={selectedVariantId === variant.id ? 'Active' : ''}
                  >
                    {variant.color}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* size selector */}
          {currentVariant?.size && currentVariant.size.length > 0 && (
            <div className="options-group">
              <label>Size:</label>
              <select
                onChange={(e) => setSelectedSize(e.target.value)}
                value={selectedSize}
              >
                {currentVariant.size.map(size => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* quantity + cart */}
          <div className="options-group quantity-and-cart">
            <input
              type="number"
              min="0"
              max="999"
              value={quantity}
              onChange={(e) => {
                const val = e.target.value;

                if (val === '') {
                  setQuantity('');
                } else {
                  const numVal = Number(val);
                  if (!isNaN(numVal) && numVal >= 0) {
                    setQuantity(numVal);
                  }
                }
              }}
              onBlur={() => {
                if (quantity === '') setQuantity(1);
              }}
              className="quantity-input"
            />

            <button onClick={handleAddToCart} className="add-to-cart-btn">
              Add to cart
            </button>
          </div>
        </div>
      </div>

      {/* related products */}
      <RelatedProducts currentProduct={product} />

      {/* materials section */}
      {product.aboutMaterials &&
        Object.keys(product.aboutMaterials).length > 0 && (
          <section className="product-materials">
            <h2>About the materials</h2>
            {Object.entries(product.aboutMaterials).map(
              ([materialName, description]) => (
                <div key={materialName} className="material-item">
                  <p>
                    <strong>{materialName}:</strong> {description}
                  </p>
                </div>
              )
            )}
          </section>
        )}
    </div>
  );
};

export default ProductDetailsPage;