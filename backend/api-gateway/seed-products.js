// runs one-shot seeder for microservices stack
// triggers hybrid saga to populate postgres and mongodb
const fs = require('fs');

// sets gateway url with fallback to localhost
// uses env variable when running inside docker
const GATEWAY_URL = process.env.SEED_GATEWAY_URL || 'http://localhost:3000';

const categoryMap = {
  "Earrings": 1,
  "Rings": 2,
  "Necklaces": 3,
  "Bracelets": 4
};

const seedProducts = async () => {
  try {
    const rawData = fs.readFileSync('./products.json', 'utf-8');
    const products = JSON.parse(rawData);

    console.log(`Found ${products.length} base products to seed...`);

    for (const product of products) {
      // transforms legacy json into api gateway payload
      const productDataToSave = {
        sku: product.id, // maps primary identifier to sku
        name: product.name,
        description: product.description,
        price: Number(product.price),
        category_id: categoryMap[product.category] || 1,
        rating: Number(product.rating) || 5,
        tags: product.tags || [],
        aboutMaterials: product.aboutMaterials || {},
        gallery: product.gallery || [],

        // normalizes variant structure for catalog service
        variants: product.variants.map((v) => ({
          id: v.id,
          color: v.color,
          priceAdjustment: Number(v.priceAdjustment) || 0,
          imageUrl: v.imageUrl,
          size: v.size || [],
          stock: 100 // sets default stock value for seeding
        }))
      };

      // posts products sequentially to trigger gateway saga individually
      const response = await fetch(`${GATEWAY_URL}/api/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(productDataToSave)
      });

      if (response.ok) {
        console.log(`success: Added ${product.name}`);
      } else {
        // pretty-prints error envelope for diagnostics
        const error = await response.json().catch(() => ({}));
        console.log(`error for ${product.name}:`, JSON.stringify(error, null, 2));
      }
    }

    console.log('seeding complete!');
  } catch (err) {
    console.error('critical script error:', err);
  }
};

seedProducts();