// migration 1: creates the base products table (schema-only, no data)
exports.up = function(knex) {
  return knex.schema.createTable('products', table => {
    table.increments('id').primary();
    table.string('name').notNullable();
    table.string('sku').unique().notNullable();
    table.decimal('price', 10, 2).notNullable();
    table.integer('stock').defaultTo(0);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('products');
};
