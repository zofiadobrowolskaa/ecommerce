// domain seed: inserts real business data (categories + products used by tests)
// idempotent: delete -> reset sequence -> insert, so every seed:run gives the same state

exports.seed = async function(knex) {
  // delete children before parents to respect fk constraints
  await knex('products').del();
  await knex('categories').del();

  // reset sequences so ids are the same every time
  await knex.raw('ALTER SEQUENCE IF EXISTS products_id_seq RESTART WITH 1');
  await knex.raw('ALTER SEQUENCE IF EXISTS categories_id_seq RESTART WITH 1');

  await knex('categories').insert([
    { id: 1, name: 'Earrings' },
    { id: 2, name: 'Rings' },
    { id: 3, name: 'Necklaces' },
    { id: 4, name: 'Bracelets' }
  ]);

  // update sequence to max id so future inserts don't collide with seeded rows
  await knex.raw("SELECT setval('categories_id_seq', (SELECT MAX(id) FROM categories))");
};
