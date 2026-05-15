// idempotent seed: every "knex seed:run" produces the exact same state
// regardless of how many times the container has been restarted.

exports.seed = async function(knex) {
  // child rows first to respect foreign key constraints
  await knex('products').del();
  await knex('categories').del();

  // reset the auto-increment sequences so the next inserts start at 1 again
  // postgres style identifiers (matches the migration column types)
  await knex.raw('ALTER SEQUENCE IF EXISTS products_id_seq RESTART WITH 1');
  await knex.raw('ALTER SEQUENCE IF EXISTS categories_id_seq RESTART WITH 1');

  // insert default domain seeds with explicit ids (referenced by tests and the
  // api-gateway product seeder via category_id)
  await knex('categories').insert([
    { id: 1, name: 'Earrings' },
    { id: 2, name: 'Rings' },
    { id: 3, name: 'Necklaces' },
    { id: 4, name: 'Bracelets' }
  ]);

  await knex.raw("SELECT setval('categories_id_seq', (SELECT MAX(id) FROM categories))");
};
