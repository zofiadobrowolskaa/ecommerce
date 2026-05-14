const fs = require('fs');

// maps legacy category names to PostgreSQL category IDs
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
      // transform legacy JSON into API Gateway-compatible structure
      const productDataToSave = {
        sku: product.id, // primary product identifier (SKU mapping)
        name: product.name,
        description: product.description,
        price: Number(product.price),
        category_id: categoryMap[product.category] || 1,
        rating: Number(product.rating) || 5,
        tags: product.tags || [],
        aboutMaterials: product.aboutMaterials || {},
        gallery: product.gallery || [],

        // normalize variant structure for catalog service
        variants: product.variants.map((v) => ({
          id: v.id,
          color: v.color,
          priceAdjustment: Number(v.priceAdjustment) || 0,
          imageUrl: v.imageUrl,
          size: v.size || [],
          stock: 100 // default stock value for seeded data
        }))
      };

      const response = await fetch('http://localhost:3000/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(productDataToSave)
      });

      if (response.ok) {
        console.log(`success: Added ${product.name}`);
      } else {
        const error = await response.json();
        console.log(`error for ${product.name}:\n`, JSON.stringify(error.details, null, 2));
      }
    }

    console.log('seeding complete!');
  } catch (err) {
    console.error('critical script error:', err);
  }
};

seedProducts();